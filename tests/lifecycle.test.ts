import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";

function launch() {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import { startHttpService } from './src/http/server.ts'; await startHttpService();",
    ],
    {
      cwd: new URL("../", import.meta.url),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ORM_SECRET_CANARY: "lifecycle-secret-canary" },
    },
  );
  let output = "";
  child.stdout.on("data", (data: Buffer) => (output += data.toString()));
  child.stderr.on("data", (data: Buffer) => (output += data.toString()));
  return { child, output: () => output };
}

describe("production process lifecycle", { concurrent: false }, () => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    it(`closes the listener and exits cleanly on ${signal}`, async () => {
      const { child, output } = launch();
      const exited = once(child, "exit");
      try {
        const deadline = Date.now() + 10_000;
        while (!output().includes("HTTP listening")) {
          if (child.exitCode !== null || Date.now() >= deadline) {
            throw new Error(`Process did not start: ${output()}`);
          }
          await delay(25);
        }
        const health = await fetch("http://127.0.0.1:8080/healthz");
        expect(health.status).toBe(200);
        child.kill(signal);
        const [code, exitSignal] = await exited;
        expect(code).toBe(0);
        expect(exitSignal).toBeNull();
        expect(output()).not.toContain("lifecycle-secret-canary");
        await expect(fetch("http://127.0.0.1:8080/healthz")).rejects.toThrow();
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await exited;
        }
      }
    }, 15_000);
  }

  it("reports a bind failure and exits without leaking its environment", async () => {
    const occupied = createServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(8080, "0.0.0.0", resolve);
    });
    const { child, output } = launch();
    const exited = once(child, "exit");
    try {
      const [code] = await exited;
      expect(code).toBe(1);
      expect(output()).toContain("HTTP startup failed.");
      expect(output()).not.toContain("lifecycle-secret-canary");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
      await new Promise<void>((resolve, reject) =>
        occupied.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 15_000);
});
