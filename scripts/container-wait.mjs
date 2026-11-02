import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setInterval, clearInterval } from "node:timers";

export async function waitForContainer(
  dockerArguments,
  name,
  { timeout = 300_000, sample, sampleInterval = 30_000 } = {},
) {
  const child = spawn(
    "docker",
    [...dockerArguments, "container", "wait", name],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (bytes) => {
    stdout += bytes;
  });
  child.stderr.on("data", (bytes) => {
    stderr += bytes;
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  const completed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== 0)
        reject(
          new Error(
            `Docker wait for ${name} exited ${code ?? signal}: ${stderr}`,
          ),
        );
      else {
        try {
          assert.match(stdout.trim(), /^\d+$/, "Invalid container exit status");
          resolve(Number(stdout.trim()));
        } catch (error) {
          reject(error);
        }
      }
    });
  });
  let watchdog, sampler;
  const monitored = new Promise((_, reject) => {
    watchdog = setTimeout(
      () =>
        reject(new Error(`Container ${name} did not exit within ${timeout}ms`)),
      timeout,
    );
    if (sample) {
      const observe = () => {
        try {
          sample();
        } catch (error) {
          reject(error);
        }
      };
      sampler = setInterval(observe, sampleInterval);
      observe();
    }
  });
  try {
    return await Promise.race([completed, monitored]);
  } finally {
    clearTimeout(watchdog);
    clearInterval(sampler);
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await closed;
  }
}
