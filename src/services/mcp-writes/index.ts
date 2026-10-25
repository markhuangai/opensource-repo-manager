import { randomUUID } from "node:crypto";
import {
  McpError,
  ErrorCode,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { SecretAccessor } from "../../config/secrets.ts";
import { immutable } from "../../config/bundles.ts";
import {
  digest,
  RuntimeError,
  type McpWriteDispatcher,
} from "../../domain/agents.ts";
import type { Store } from "../../repositories/store.ts";
import { McpWriteRepository } from "../../repositories/mcp-writes.ts";
import type { BootstrapLease, Supervisor } from "../../runtime/supervisor.ts";
import type { ExternalOutputReview } from "../publication/review.ts";
import type { ReviewRequest } from "../publication/contracts.ts";
import { budget } from "../mcp/http.ts";
import {
  canonical,
  reviewedWriteInput,
  type McpWriteOperation,
  type McpWriteChannel,
  type McpWriteTransport,
  type WriteBinding,
  type WriteResponse,
} from "./contracts.ts";
import { resolveWriteEvidence } from "./evidence.ts";
import { policyIdentity } from "../publication/scanner.ts";

export class McpWriteService implements McpWriteDispatcher {
  readonly repository: McpWriteRepository;
  private readonly active = new Set<number>();
  private readonly supervisor: Supervisor;
  private readonly store: Store;
  private readonly secrets: SecretAccessor;
  private readonly review: ExternalOutputReview;
  private readonly transport?: McpWriteTransport;
  private readonly sourceUrl?: (repository: string) => string;
  constructor(
    supervisor: Supervisor,
    store: Store,
    secrets: SecretAccessor,
    review: ExternalOutputReview,
    transport?: McpWriteTransport,
    sourceUrl?: (repository: string) => string,
  ) {
    this.supervisor = supervisor;
    this.store = store;
    this.secrets = secrets;
    this.review = review;
    this.transport = transport;
    this.sourceUrl = sourceUrl;
    this.repository = new McpWriteRepository(store);
  }

  async initialize() {
    this.repository.interrupt();
    for (const operation of this.repository.all(["uncertain"]))
      if (
        operation.state === "uncertain" &&
        operation.notification !== "enqueued"
      )
        await this.notify(operation);
  }

  receipt(id: string) {
    return this.repository.receipt(id);
  }

  assertAvailable(reviewRequired: boolean) {
    if (reviewRequired && !this.supervisor.outputReviewAvailable())
      throw new RuntimeError("mcp_write_review_unavailable");
  }

  status() {
    const counts = this.repository.counts();
    return {
      ...counts,
      reason: counts.uncertain
        ? "mcp_write_uncertain"
        : counts.notification_failed
          ? "mcp_write_notification_failed"
          : null,
    };
  }

  private async exclusive<T>(jobId: number, work: () => Promise<T>) {
    if (this.active.has(jobId)) throw new RuntimeError("mcp_write_busy");
    this.active.add(jobId);
    try {
      return await work();
    } finally {
      this.active.delete(jobId);
    }
  }

  async dispatch(
    request: Parameters<McpWriteDispatcher["dispatch"]>[0],
    channel: McpWriteChannel,
  ): Promise<CallToolResult> {
    const input = immutable(structuredClone(request.arguments)),
      binding = immutable(structuredClone(request.binding));
    return this.exclusive(binding.job_id, async () => {
      channel.assertCurrent();
      this.assertAvailable(binding.review_required);
      this.authority(binding);
      if (digest(binding) !== digest(channel.binding))
        throw new RuntimeError("mcp_write_binding_changed");
      const now = Date.now(),
        operation: McpWriteOperation = {
          id: randomUUID(),
          job_id: binding.job_id,
          revision: binding.revision,
          state: "proposed",
          binding,
          request_digest: digest(input),
          arguments: null,
          purpose: null,
          evidence: null,
          idempotency_key: null,
          review_id: null,
          review: binding.review_required ? "required" : "not_required",
          deadline: request.deadline,
          created_at: now,
          updated_at: now,
          failure: null,
          response: null,
          notification: null,
        };
      this.repository.begin(operation);
      try {
        const limit = this.store.snapshot(binding.snapshot_digest).settings.mcp
          .max_request_bytes;
        this.bounded(input, limit);
        await this.review.scanner.scan(input, request.signal);
        let args: Record<string, unknown>;
        if (binding.review_required) {
          const envelope = reviewedWriteInput.safeParse(input);
          if (!envelope.success)
            throw new RuntimeError("mcp_write_envelope_invalid");
          args = envelope.data.arguments;
          const evidence = await resolveWriteEvidence(
            this.store,
            this.secrets,
            this.supervisor.workspaces.privateRoot + "/mcp-writes",
            binding,
            envelope.data.evidence,
            limit,
            request.signal,
            this.sourceUrl,
          );
          const payload = {
            arguments: args,
            purpose: envelope.data.purpose,
            evidence,
          };
          this.bounded(payload, limit);
          await this.review.scanner.scan(payload, request.signal);
          operation.purpose = envelope.data.purpose;
          operation.evidence = evidence;
        } else args = input;
        if (
          binding.idempotency_argument &&
          Object.hasOwn(args, binding.idempotency_argument)
        )
          throw new RuntimeError("mcp_write_idempotency_owned");
        operation.idempotency_key = binding.idempotency_argument
          ? randomUUID()
          : null;
        operation.arguments = canonical({
          ...args,
          ...(binding.idempotency_argument
            ? { [binding.idempotency_argument]: operation.idempotency_key }
            : {}),
        });
        if (!channel.validate(operation.arguments))
          throw new RuntimeError("mcp_arguments_invalid");
        this.bounded(
          {
            method: "tools/call",
            params: { name: binding.tool, arguments: operation.arguments },
          },
          Math.max(0, limit - 128),
        );
        operation.request_digest = digest(operation.arguments);
        this.repository.save(operation);
        if (binding.review_required) {
          await this.review.review(
            this.reviewRequest(operation, true),
            request.signal,
            undefined,
            (receipt) => {
              operation.review_id = receipt.id;
              this.repository.save(operation);
            },
            [
              binding.credential_binding,
              ...(operation.idempotency_key ? [operation.idempotency_key] : []),
            ],
          );
          this.repository.save(operation);
        }
        return await this.transmit(operation, channel, request.signal, false);
      } catch (error) {
        const saved = this.repository.operation(operation.id);
        if (saved.state === "response_recorded") throw error;
        if (saved.state === "proposed") {
          saved.state = "rejected";
          saved.failure = this.failure(error);
          this.repository.save(saved);
        }
        throw new RuntimeError(this.failure(error));
      }
    });
  }

  async recover(id: string, signal: AbortSignal) {
    const stored = this.repository.operation(id);
    if (stored.state === "response_recorded") return this.deliver(stored);
    if (stored.state !== "uncertain")
      throw new RuntimeError("mcp_write_recovery_denied");
    return this.exclusive(stored.job_id, async () => {
      const call = budget(stored.deadline, signal);
      try {
        call.assertActive();
        this.authority(stored.binding);
        if (
          !stored.binding.idempotency_argument ||
          !stored.idempotency_key ||
          !stored.arguments ||
          stored.arguments[stored.binding.idempotency_argument] !==
            stored.idempotency_key ||
          digest(stored.arguments) !== stored.request_digest
        )
          throw new RuntimeError("mcp_write_replay_unsafe");
        if (!this.transport) throw new RuntimeError("mcp_write_unavailable");
        return await this.supervisor.withMcpWriteRecovery(
          id,
          call.signal,
          async (lease) => {
            const current = () => {
              this.authority(stored.binding);
              if (!this.store.mcpWriteRecoveryCurrent(lease.lease, id))
                throw new RuntimeError("mcp_write_recovery_denied");
              lease.signal.throwIfAborted();
            };
            const channel = await this.transport!.openRecovery(
              stored.binding,
              stored.deadline,
              lease.signal,
              current,
            );
            try {
              current();
              if (!channel.validate(stored.arguments!))
                throw new RuntimeError("mcp_write_binding_changed");
              await this.review.scanner.scan(
                {
                  arguments: stored.arguments,
                  evidence: stored.evidence,
                  purpose: stored.purpose,
                },
                lease.signal,
                stored.idempotency_key ? [stored.idempotency_key] : [],
              );
              if (stored.binding.review_required) {
                await this.review.review(
                  this.reviewRequest(stored, false),
                  lease.signal,
                  lease,
                  (receipt) => {
                    stored.review_id = receipt.id;
                    this.repository.save(stored);
                  },
                  [stored.binding.credential_binding, stored.idempotency_key!],
                );
                this.repository.save(stored);
              }
              return await this.transmit(
                stored,
                channel,
                lease.signal,
                true,
                lease,
              );
            } finally {
              await channel.close();
            }
          },
        );
      } catch (error) {
        const operation = this.repository.operation(id);
        if (operation.state === "response_recorded") throw error;
        if (operation.state === "uncertain") {
          operation.failure = this.failure(error);
          this.repository.save(operation);
          await this.notify(operation);
        }
        throw new RuntimeError(this.failure(error));
      } finally {
        call.dispose();
      }
    });
  }

  private authority(binding: WriteBinding) {
    const job = this.store.jobById(binding.job_id),
      repository = this.store.repository();
    if (
      !job ||
      job.status !== "pending" ||
      job.revision !== binding.revision ||
      job.phase !== binding.phase ||
      job.snapshot_digest !== binding.snapshot_digest ||
      digest((JSON.parse(job.input_json) as { source: unknown }).source) !==
        digest(binding.source) ||
      repository?.id !== binding.repository_id ||
      repository.full_name !== binding.repository ||
      this.supervisor.repositoryName() !== binding.repository ||
      binding.scanner_policy !== policyIdentity
    )
      throw new RuntimeError("mcp_write_authority_changed");
  }

  private reviewRequest(
    operation: McpWriteOperation,
    parent: boolean,
  ): ReviewRequest {
    return {
      job_id: operation.job_id,
      revision: operation.revision,
      destination: { type: "mcp_write", ...operation.binding },
      payload: {
        operation_id: operation.id,
        arguments: operation.arguments,
        purpose: operation.purpose,
        deadline: operation.deadline,
        review: operation.review,
      },
      evidence: operation.evidence,
      ...(operation.binding.artifact_digest
        ? { artifact_digest: operation.binding.artifact_digest }
        : {}),
      ...(parent ? { parent_run_id: operation.binding.run_id } : {}),
    };
  }

  private async transmit(
    operation: McpWriteOperation,
    channel: McpWriteChannel,
    signal: AbortSignal,
    recovery: boolean,
    lease?: BootstrapLease,
  ) {
    signal.throwIfAborted();
    this.authority(operation.binding);
    channel.assertCurrent();
    if (digest(channel.binding) !== digest(operation.binding))
      throw new RuntimeError("mcp_write_binding_changed");
    if (operation.binding.review_required)
      this.review.verify(
        operation.review_id!,
        this.reviewRequest(operation, !recovery),
      );
    if (lease && !this.store.mcpWriteRecoveryCurrent(lease.lease, operation.id))
      throw new RuntimeError("mcp_write_recovery_denied");
    this.repository.dispatch(operation, recovery);
    let response: WriteResponse;
    try {
      try {
        response = {
          kind: "result",
          value: await channel.transmit(operation.arguments!, signal),
        };
      } catch (error) {
        if (
          !(error instanceof McpError) ||
          [ErrorCode.ConnectionClosed, ErrorCode.RequestTimeout].includes(
            error.code,
          )
        )
          throw error;
        response = {
          kind: "error",
          value: {
            code: error.code,
            message: error.message,
            ...(error.data === undefined ? {} : { data: error.data }),
          },
        };
      }
      this.bounded(
        response,
        this.store.snapshot(operation.binding.snapshot_digest).settings.mcp
          .max_response_bytes - 512,
      );
      await this.review.scanner.scan(
        response,
        AbortSignal.timeout(30000),
        operation.idempotency_key ? [operation.idempotency_key] : [],
      );
      this.repository.finish(operation, response, null);
    } catch (error) {
      this.supervisor.blockMcpWriteJob(operation.job_id);
      this.repository.finish(operation, null, this.failure(error));
      await this.notify(operation);
      throw new RuntimeError("mcp_write_uncertain");
    }
    signal.throwIfAborted();
    this.authority(operation.binding);
    channel.assertCurrent();
    return this.deliver(operation);
  }

  private deliver(operation: McpWriteOperation): CallToolResult {
    if (!operation.response) throw new RuntimeError("mcp_write_result_missing");
    const receipt = {
      operation_id: operation.id,
      state: operation.state,
      review: operation.review,
    };
    if (operation.response.kind === "error")
      throw new McpError(
        operation.response.value.code,
        operation.response.value.message,
        { provider_data: operation.response.value.data, receipt },
      );
    const result = structuredClone(operation.response.value);
    return {
      ...result,
      _meta: { ...result._meta, "opensource-repo-manager/receipt": receipt },
    };
  }

  private failure(error: unknown) {
    const allowed = new Set([
      "publication_secret",
      "publication_scan_failed",
      "publication_size_limit",
      "publication_structured_invalid",
      "mcp_write_envelope_invalid",
      "mcp_write_evidence_mismatch",
      "mcp_write_evidence_path_invalid",
      "mcp_write_evidence_range_invalid",
      "mcp_write_evidence_limit",
      "mcp_write_idempotency_owned",
      "mcp_arguments_invalid",
      "mcp_write_deadline_expired",
      "infrastructure_budget_exhausted",
      "active_budget_exhausted",
      "mcp_write_replay_unsafe",
      "mcp_write_authority_changed",
      "mcp_write_binding_changed",
      "mcp_policy_mismatch",
      "output_review_rejected",
      "output_review_mismatch",
      "cleanup_failed",
      "mcp_write_unavailable",
      "mcp_write_recovery_denied",
      "mcp_write_uncertain",
      "mcp_timeout",
      "mcp_cancelled",
      "mcp_result_invalid",
      "mcp_secret_in_response",
      "mcp_response_limit",
      "mcp_write_limit",
      "lease_busy",
    ]);
    return error instanceof RuntimeError && allowed.has(error.code)
      ? error.code
      : "mcp_write_failed";
  }

  private bounded(value: unknown, limit: number) {
    if (Buffer.byteLength(JSON.stringify(value)) > limit)
      throw new RuntimeError("mcp_write_limit");
    if (this.secrets.containsCredentials(value))
      throw new RuntimeError("publication_secret");
  }

  private async notify(operation: McpWriteOperation) {
    if (operation.notification === "enqueued") return;
    try {
      const job = this.store.jobById(operation.job_id)!,
        repository = this.store.repository()!;
      const prepared = this.supervisor.notifications.prepare({
        id: `mcp-write-${operation.id}`,
        job_id: job.id,
        revision: job.revision,
        repository_id: repository.id,
        issue_number: job.issue_number,
        occurred_at: operation.created_at,
        outcome: "needs_attention",
        reason: "workflow_blocked",
      });
      await this.supervisor.notifications.enqueue(
        prepared,
        {},
        AbortSignal.timeout(30000),
      );
      operation.notification = "enqueued";
    } catch {
      operation.notification = "failed";
    }
    this.repository.save(operation);
  }
}
