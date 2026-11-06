import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { userProcesses } from "/opt/orm/app/dist/runtime/process.js";

export async function respondAiTest(req, res, profile, key, mode = "success") {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  assert.equal(req.headers.authorization, `Bearer ${key}`);
  assert.equal(body.model, profile.model);
  if (req.url.endsWith("count_tokens")) {
    res.setHeader("content-type", "application/json");
    res.end('{"input_tokens":20}');
    return body;
  }
  assert.equal((body.output_config ?? body.reasoning).effort, profile.effort);
  if (mode === "hold") return body;
  if (mode === "rejected") {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(
      '{"error":{"type":"invalid_request_error","message":"Fixture rejects the selected model."}}',
    );
    return body;
  }
  const text = mode === "empty" ? "" : "AI connection works.";
  res.setHeader("content-type", "text/event-stream");
  const frame = (event, value) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
  if (profile.sdk === "claude") {
    frame("message_start", {
      type: "message_start",
      message: {
        id: "msg_probe",
        type: "message",
        role: "assistant",
        model: profile.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 20,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    });
    frame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    frame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    });
    frame("content_block_stop", { type: "content_block_stop", index: 0 });
    frame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 5 },
    });
    frame("message_stop", { type: "message_stop" });
  } else {
    const item = {
      id: "msg_probe",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    };
    const response = {
      id: "resp_probe",
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "in_progress",
      output: [],
    };
    frame("response.created", { type: "response.created", response });
    frame("response.output_item.added", {
      type: "response.output_item.added",
      output_index: 0,
      item,
    });
    frame("response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: text,
    });
    frame("response.output_item.done", {
      type: "response.output_item.done",
      output_index: 0,
      item,
    });
    frame("response.completed", {
      type: "response.completed",
      response: {
        ...response,
        status: "completed",
        output: [item],
        usage: {
          input_tokens: 20,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 5,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 25,
        },
      },
    });
  }
  res.end();
  return body;
}

export async function verifyAiTest(configuration, source) {
  let profile, mode, reached;
  const errors = [];
  const server = createServer((req, res) => {
    void respondAiTest(req, res, profile, configuration.proxy.key, mode)
      .then((body) => {
        assert(!JSON.stringify(body).includes(configuration.github.token));
        reached = true;
      })
      .catch((error) => {
        errors.push(error);
        res.destroy();
      });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  const receipts = [];
  try {
    for (const sdk of ["claude", "codex"]) {
      for (const scenario of [
        "success",
        "rejected",
        "empty",
        "cancelled",
        "deadline",
      ]) {
        const config = globalThis.structuredClone(configuration);
        config.proxy.url = endpoint;
        config.limits.active_minutes =
          scenario === "deadline" ? 1 : config.limits.active_minutes;
        profile = { sdk, model: `proxy/${sdk}-probe`, effort: "high" };
        config.profiles[config.roles.audit.profile] = profile;
        mode = ["cancelled", "deadline"].includes(scenario) ? "hold" : scenario;
        reached = false;
        const child = spawn(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `
          import {testAiConfiguration} from '/opt/orm/app/dist/actions/test-ai.js';
          let input=''; for await (const chunk of process.stdin) input+=chunk;
          const {config,source}=JSON.parse(input); const controller=new AbortController();
          process.once('SIGTERM',()=>controller.abort());
          const result=await testAiConfiguration(config,'audit',source,controller.signal);
          console.log(JSON.stringify(result)); process.exitCode=result.outcome==='completed'?0:1;
        `,
          ],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
        let stdout = "",
          stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        const exited = new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
        child.stdin.end(JSON.stringify({ config, source }));
        if (scenario === "cancelled") {
          const until = Date.now() + 45000;
          while (!reached && child.exitCode === null) {
            assert(Date.now() < until, "AI probe did not reach upstream");
            await delay(25);
          }
          child.kill("SIGTERM");
        }
        const code = await exited;
        assert(
          stdout.trim(),
          `${sdk}/${scenario}: probe exited ${code}: ${stderr}`,
        );
        const result = JSON.parse(stdout.trim());
        assert.equal(
          result.outcome,
          scenario === "success" ? "completed" : "failed",
          stdout + stderr,
        );
        assert.equal(code, scenario === "success" ? 0 : 1, stderr);
        if (scenario === "cancelled") assert.equal(result.reason, "cancelled");
        if (scenario === "deadline")
          assert.equal(result.reason, "ai_test_timeout");
        assert.equal(result.sdk, sdk);
        assert.equal(result.role, "audit");
        assert.equal(result.cleanup, "passed");
        assert(result.model_requests >= 1 && result.model_requests <= 2);
        assert.equal((await userProcesses(10003)).length, 0);
        assert.deepEqual(await readdir("/data/ai-tests"), []);
        for (const secret of [
          config.github.token,
          config.proxy.key,
          endpoint,
          profile.model,
        ])
          assert(!(stdout + stderr).includes(secret));
        assert(!stdout.includes("AI connection works."));
        const logs = stderr
          .split("\n")
          .filter((line) => line.startsWith("{"))
          .map((line) => JSON.parse(line));
        assert(
          logs.some(
            (log) =>
              log.event === "ai.test.finished" && log.cleanup === "passed",
          ),
        );
        if (scenario === "rejected")
          assert(
            logs.some(
              (log) =>
                log.event === "model.request.failed" &&
                log.provider_status === 400 &&
                log.cause === "upstream_rejected",
            ),
          );
        receipts.push({
          sdk,
          scenario,
          outcome: result.outcome,
          cleanup: result.cleanup,
        });
      }
    }
    assert.deepEqual(errors, []);
    return { scenarios: receipts, cleanup: "passed" };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
