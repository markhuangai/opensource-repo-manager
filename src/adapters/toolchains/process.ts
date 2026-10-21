import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { Role } from "../../config/schema.ts";
import type { SecretAccessor } from "../../config/secrets.ts";
import { RuntimeError, roleUsers } from "../../domain/agents.ts";
import { cleanUser, spawnAsRole } from "../../runtime/process.ts";
import type { CommandReceipt } from "../../services/bootstrap/contracts.ts";

export async function runCommand(
  command: string,
  argv: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    signal: AbortSignal;
    limit: number;
    processes?: number;
    role?: Role;
    operation: string;
    secrets: SecretAccessor;
    record: (receipt: CommandReceipt) => void;
    capture_nonzero?: boolean;
  },
) {
  options.signal.throwIfAborted();
  if (options.secrets.containsCredentials([command, argv, options.cwd]))
    throw new RuntimeError("secret_in_request");
  const receipt: CommandReceipt = {
    id: randomUUID(),
    operation: options.operation,
    argv: [command, ...argv],
    cwd: options.cwd,
    uid: options.role ? roleUsers[options.role].uid : 0,
    started_at: Date.now(),
    finished_at: null,
    exit_code: null,
    output_digest: null,
    output_bytes: 0,
    outcome: "running",
  };
  options.record(receipt);
  const child = options.role
    ? spawnAsRole(options.role, command, argv, {
        cwd: options.cwd,
        env: options.env,
        processes: options.processes ?? 128,
      })
    : spawn(command, argv, {
        cwd: options.cwd,
        env: options.env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
  let bytes = 0,
    failure: RuntimeError | undefined;
  let termination: Promise<void> | undefined;
  const hash = createHash("sha256"),
    output: Buffer[] = [],
    errors: Buffer[] = [];
  const stop = () => {
    if (!child.pid) return;
    try {
      process.kill(options.role ? child.pid : -child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH")
        failure = new RuntimeError("cleanup_failed");
    }
    if (options.role)
      termination ??= cleanUser(roleUsers[options.role].uid).catch(() => {
        failure = new RuntimeError("cleanup_failed");
        child.stdout?.destroy();
        child.stderr?.destroy();
      });
  };
  options.signal.addEventListener("abort", stop, { once: true });
  for (const [stream, chunks] of [
    [child.stdout!, output],
    [child.stderr!, errors],
  ] as const) {
    const decoder = new TextDecoder(),
      credentials = options.secrets.createCredentialStream();
    stream.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      hash.update(chunk);
      if (bytes > options.limit) failure ??= new RuntimeError("output_limit");
      if (credentials.push(decoder.decode(chunk, { stream: true })))
        failure ??= new RuntimeError("secret_in_output");
      if (failure) stop();
      else chunks.push(chunk);
    });
  }
  try {
    child.stdin?.end();
    const code = await new Promise<number | null>((resolve) => {
      child.once("error", () => {
        failure ??= new RuntimeError("command_start_failed");
      });
      child.once("close", resolve);
      if (options.signal.aborted) stop();
    });
    receipt.exit_code = code;
    await termination;
    if (failure?.code === "cleanup_failed") throw failure;
    options.signal.throwIfAborted();
    if (failure) throw failure;
    if (code === null) throw new RuntimeError("command_interrupted");
    if (code !== 0 && !options.capture_nonzero) {
      if (
        options.role &&
        /(?:\b(?:E401|E403|401 Unauthorized|403 Forbidden)\b|authentication required|credentials required)/i.test(
          Buffer.concat([...output, ...errors]).toString("utf8"),
        )
      )
        throw new RuntimeError("private_dependency_required");
      throw new RuntimeError("bootstrap_command_failed");
    }
    receipt.outcome = "completed";
    return {
      exit_code: code,
      stdout: Buffer.concat(output).toString("utf8"),
      stderr: Buffer.concat(errors).toString("utf8"),
    };
  } finally {
    options.signal.removeEventListener("abort", stop);
    receipt.finished_at = Date.now();
    receipt.output_digest = hash.digest("hex");
    receipt.output_bytes = bytes;
    if (receipt.outcome !== "completed")
      receipt.outcome = options.signal.aborted ? "interrupted" : "failed";
    options.record(receipt);
  }
}
