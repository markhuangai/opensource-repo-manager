import { createApp } from "./http/app.ts";

const app = createApp();
let stopping = false;

async function shutdown() {
  if (stopping) return;
  stopping = true;

  const deadline = setTimeout(() => {
    console.error("Shutdown exceeded its 10-second deadline.");
    process.exit(1);
  }, 10_000);
  deadline.unref();

  try {
    await app.close();
  } catch {
    console.error("HTTP shutdown failed.");
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
  }
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

try {
  await app.listen({ host: "0.0.0.0", port: 8080 });
  console.log(
    "HTTP listening on port 8080; maintenance automation is unavailable.",
  );
} catch {
  console.error("HTTP startup failed.");
  process.exitCode = 1;
  await app.close();
}
