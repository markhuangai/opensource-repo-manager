import { fileURLToPath } from "node:url";
import { createGitHubReader } from "../adapters/github/reader.ts";
import type { RunSnapshot } from "../config/load.ts";
import type { SecretAccessor } from "../config/secrets.ts";
import type { SafeLogger } from "../logging/redact.ts";
import type { Store } from "../repositories/store.ts";
import { IntakeService } from "../services/intake.ts";
import { InvestigationService } from "../services/investigation/index.ts";
import { ImplementationService } from "../services/implementation/index.ts";
import { PrMonitorService } from "../services/pr-monitor/index.ts";
import { McpGateway } from "../services/mcp/index.ts";
import { Supervisor } from "./supervisor.ts";
import type { GitHubWriter } from "../adapters/github/writer.ts";

export async function createApplication(
  store: Store,
  loaded: { snapshot: RunSnapshot; secrets: SecretAccessor },
  logger: SafeLogger,
  options: {
    mode: "service" | "actions";
    root?: string;
    publicationWriter?: (ready: () => void) => GitHubWriter;
  },
) {
  const mcp =
    options.mode === "service"
      ? new McpGateway(store, loaded.snapshot, loaded.secrets)
      : undefined;
  let supervisor: Supervisor | undefined;
  let intake: IntakeService | undefined;
  let investigation: InvestigationService | undefined;
  let monitor: PrMonitorService | undefined;
  let stopping: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      const results = await Promise.allSettled([
        monitor?.stop(),
        investigation?.stop(),
        intake?.stop(),
      ]);
      for (const result of results)
        if (result.status === "rejected") throw result.reason;
    })());
  const close = () =>
    (closing ??= (async () => {
      try {
        await stop();
      } finally {
        try {
          await supervisor?.close();
        } finally {
          try {
            await mcp?.close();
          } finally {
            if (store.db.open) {
              try {
                if (store.durability)
                  await store.checkpoint(
                    AbortSignal.timeout(9000),
                    options.mode === "actions",
                  );
              } finally {
                store.close();
              }
            }
          }
        }
      }
    })());
  try {
    supervisor = await Supervisor.create(
      store,
      loaded.snapshot,
      loaded.secrets,
      {
        root: options.root,
        publicationWriter: options.publicationWriter,
        mcp,
        workers: {
          claude: fileURLToPath(
            new URL("../adapters/agents/claude.js", import.meta.url),
          ),
          codex: fileURLToPath(
            new URL("../adapters/agents/codex.js", import.meta.url),
          ),
        },
      },
    );
    if (mcp) {
      mcp.setWriteDispatcher(supervisor.mcpWrites);
      mcp.setReadResultScanner(supervisor.publication.outputReview.scanner);
      await mcp.start();
    }
    const reader = createGitHubReader(
      loaded.snapshot.settings.github.repository,
      loaded.secrets.get("github.token"),
    );
    intake = new IntakeService(
      store,
      reader,
      loaded.snapshot,
      loaded.secrets,
      logger,
      {
        beforeIssue: async (context, signal) =>
          investigation?.beforeIssue(context, signal),
        changed: () => {
          investigation?.wake();
          monitor?.wake();
        },
      },
    );
    const implementation = new ImplementationService(
      store,
      intake,
      supervisor,
      loaded.secrets,
      logger,
    );
    monitor = new PrMonitorService(
      store,
      intake,
      reader,
      implementation,
      supervisor,
      loaded.snapshot,
      loaded.secrets,
      logger,
    );
    investigation = new InvestigationService(
      store,
      intake,
      supervisor,
      loaded.secrets,
      logger,
      undefined,
      implementation,
    );
    monitor.setCoordinatorWake(() => investigation?.wake());
    return {
      store,
      supervisor,
      intake,
      implementation,
      monitor,
      investigation,
      stop,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export type Application = Awaited<ReturnType<typeof createApplication>>;
