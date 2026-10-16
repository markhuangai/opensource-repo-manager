import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  agentEventSchema,
  roleUsers,
  type WorkerRequest,
} from "../domain/agents.ts";

const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
let request: WorkerRequest | undefined;
const output = createWriteStream("/dev/null", { fd: 3, autoClose: true });
output.on("error", () => controller.abort());
async function send(event: unknown) {
  if (!request) return;
  const envelope = JSON.stringify({
    run_id: request.run_id,
    job_id: request.job_id,
    revision: request.revision,
    event,
  });
  await new Promise<void>((resolve, reject) =>
    output.write(envelope + "\n", (error) =>
      error ? reject(error) : resolve(),
    ),
  );
}
try {
  let input = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    if (input.length + chunk.length > 32 * 1024 * 1024)
      throw new Error("request_limit");
    input = Buffer.concat([input, chunk]);
  }
  request = JSON.parse(
    new TextDecoder("utf8", { fatal: true }).decode(input),
  ) as WorkerRequest;
  const identity = roleUsers[request.role],
    status = await readFile("/proc/self/status", "utf8");
  if (
    !identity ||
    process.getuid?.() !== identity.uid ||
    process.getgid?.() !== identity.gid ||
    !/^NoNewPrivs:\s+1$/m.test(status) ||
    !/^Groups:\s*$/m.test(status) ||
    ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"].some(
      (name) => !new RegExp(`^${name}:\\s+0+$`, "m").test(status),
    )
  )
    throw new Error("identity_invalid");
  const adapter = (await import(pathToFileURL(process.argv[2]).href)) as {
    run(request: WorkerRequest, signal: AbortSignal): AsyncIterable<unknown>;
  };
  let terminal = false;
  for await (const value of adapter.run(request, controller.signal)) {
    if (terminal) throw new Error("event_after_terminal");
    const event = agentEventSchema.parse(value);
    if (event.type === "terminal") terminal = true;
    await send(event);
  }
  if (!terminal)
    await send({
      type: "terminal",
      outcome: controller.signal.aborted ? "cancelled" : "failed",
    });
} catch {
  await send({
    type: "terminal",
    outcome: controller.signal.aborted ? "cancelled" : "failed",
  });
  process.exitCode = 1;
} finally {
  output.end();
}
