import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { verifyAgent } from "./conformance.mjs";

export async function respond(req, res, fixture) {
  const { config, mcpCredential, store, root, requests, histories, errors } =
    fixture;
  try {
    let data = "";
    for await (const chunk of req) data += chunk;
    const body = JSON.parse(data);
    assert.equal(req.headers.authorization, `Bearer ${config.proxy.key}`);
    assert.equal(body.model, "auto");
    if (req.url.startsWith("/v1/messages/count_tokens")) {
      res.setHeader("content-type", "application/json");
      res.end('{"input_tokens":20}');
      return;
    }
    assert(req.url.startsWith("/v1/messages"));
    assert.equal(body.output_config.effort, "xhigh");
    assert(!JSON.stringify(body).includes(config.proxy.key));
    assert(!JSON.stringify(body).includes(config.github.token));
    assert(!JSON.stringify(body).includes(mcpCredential));
    const text = body.messages
      .flatMap((message) =>
        typeof message.content === "string"
          ? [message.content]
          : message.content
              .filter((block) => block.type === "text")
              .map((block) => block.text),
      )
      .join("\n");
    const scenario =
      /"scenario":"([^"]+)"/.exec(text)?.[1] ??
      /"task":"(bootstrap_[^"]+|investigation_[^"]+|external_output_review)"/.exec(
        text,
      )?.[1];
    assert(scenario, "Missing verbatim task context");
    assert(JSON.stringify(body.system).includes("OPERATOR_SYSTEM_CANARY"));
    assert(JSON.stringify(body.system).includes("OPERATOR_SKILL_CANARY"));
    assert(text.includes("OPERATOR_USER_CANARY"));
    assert(!JSON.stringify(body).includes("HOSTILE_CONTEXT_CANARY"));
    const toolNames = body.tools?.map((tool) => tool.name) ?? [];
    assert(
      !toolNames.some((name) =>
        /Agent|Task|Skill|WebSearch|WebFetch/.test(name),
      ),
    );
    requests.push({ scenario, body });
    const active = store.runs().findLast((run) => run.finished_at === null);
    let history = histories.get(active.job_id);
    const initial = !history && ["tools", "limited"].includes(scenario);
    if (initial) {
      history = { marker: `prior_turn_${randomUUID()}`, run: active.id };
      histories.set(active.job_id, history);
    } else if (history && history.run !== active.id && !history.checked) {
      assert(text.includes(history.marker), "Resumed conversation was lost");
      history.checked = true;
    }
    const last = body.messages.findLast((message) => message.role === "user");
    const results = Array.isArray(last.content)
      ? last.content.filter((block) => block.type === "tool_result")
      : [];
    let content = [{ type: "text", text: "fixture-completed" }],
      stop = "end_turn";
    const use = (name, input) => {
      assert(toolNames.includes(name), `SDK did not advertise ${name}`);
      content = [
        {
          type: "tool_use",
          id: `call_${name}_${requests.length}`,
          name,
          input,
        },
      ];
      stop = "tool_use";
    };
    if (scenario === "cancel" && results.length) {
      fixture.held = true;
      return;
    }
    if (scenario === "malformed") {
      res.setHeader("content-type", "text/event-stream");
      res.end("event: message_start\ndata: {not-json}\n\n");
      return;
    }
    if (scenario === "external_output_review") {
      assert(!toolNames.includes("Bash"));
      assert(!toolNames.some((name) => name.startsWith("mcp__")));
      use("StructuredOutput", await fixture.outputReview(text));
    } else if (
      ["investigation_plan", "investigation_result"].includes(scenario)
    ) {
      const call = await fixture.investigation(scenario, text, results);
      if (call.tool) use(call.tool, call.arguments);
      else use("StructuredOutput", call.result);
    } else if (["bootstrap_plan", "bootstrap_audit"].includes(scenario)) {
      use("StructuredOutput", fixture.bootstrap(scenario, text));
    } else if (scenario === "bootstrap_environment" && !results.length) {
      use("Bash", {
        command: fixture.environmentCommand,
        timeout: 600000,
        description: "Verify the prepared toolchain and dependency environment",
      });
    } else if (scenario === "bootstrap_environment") {
      assert(!results.at(-1).is_error, JSON.stringify(results.at(-1)));
      const latest =
        typeof results.at(-1).content === "string"
          ? results.at(-1).content
          : results
              .at(-1)
              .content.map((block) => block.text ?? "")
              .join("\n");
      assert(/(?:^|\n)BOOTSTRAP_TESTS_PASSED(?:\n|$)/.test(latest), latest);
    } else if (scenario === "mcp_write") {
      if (!results.length)
        use(
          `mcp__${fixture.writeAlias}__${fixture.writeTool}`,
          fixture.writeInput,
        );
      else fixture.writeResults.push(results.at(-1));
    } else if (scenario === "crash") {
      use("Bash", {
        command: 'kill -ABRT "$PPID"',
        description: "Crash the native SDK process",
      });
    } else if (scenario === "review") {
      assert(toolNames.includes("Read"));
      assert(!toolNames.includes("Write"));
      assert(!toolNames.includes("Edit"));
      if (!results.length)
        use("Bash", {
          command: 'test "$(id -u)" = 10002 && cat app.txt',
          description: "Inspect independent audit workspace",
        });
    } else if (scenario === "output_review") {
      assert(!toolNames.includes("Bash"));
      assert(!toolNames.some((name) => name.startsWith("mcp__")));
      if (!results.length) {
        const active = store.runs().findLast((run) => run.finished_at === null);
        use("Read", {
          file_path: join(root, "runs", active.id, "workspace", "app.txt"),
        });
      }
    } else if (
      ["mcp", "expiry", "cancel_mcp"].includes(scenario) &&
      !results.length
    )
      use("mcp__context__read", {});
    else if (scenario === "mcp" && results[0].tool_use_id.includes("context")) {
      assert(!results[0].is_error);
      const script = `import fs from 'node:fs';
          let pid=process.ppid, setting;
          for(let i=0;i<6&&!setting;i++){
            const args=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\\0');
            const idx=args.findIndex(a=>a==='--mcp-config'||a.startsWith('--mcp-config='));
            if(idx>=0) setting=JSON.parse(args[idx].includes('=')?args[idx].slice(args[idx].indexOf('=')+1):args[idx+1]);
            else pid=Number(/^PPid:\\s+(\\d+)/m.exec(fs.readFileSync('/proc/'+pid+'/status','utf8'))[1]);
          }
          if(!setting) throw Error('no SDK descriptor');
          const c=setting.mcpServers.context;
          const r=await fetch(c.url,{method:'POST',headers:{...c.headers,'content-type':'application/json',accept:'application/json, text/event-stream','mcp-session-id':${JSON.stringify(fixture.downstreamId)}},
            body:JSON.stringify({jsonrpc:'2.0',id:99123,method:'tools/call',params:{name:'hidden',arguments:{}}})});
          const text=await r.text();
          if(r.ok&&!text.includes('"error"')&&!text.includes('"isError":true')) throw Error('raw grant bypass');
          fs.writeFileSync('raw-denied','yes');console.log('raw-denied');`;
      use("Bash", {
        command: `/opt/orm-runtime/bin/node --input-type=module -e '${script.replaceAll("'", "'\\''")}'`,
        description: "Probe raw MCP authorization",
      });
    } else if (
      ["tools", "hostile", "limited", "cancel"].includes(scenario) &&
      !results.length
    ) {
      const file = scenario === "limited" ? "partial.txt" : "effects.txt";
      const active = store.runs().findLast((run) => run.finished_at === null);
      const reference = join(
        root,
        "runs",
        active.id,
        "bundle",
        "skills",
        "example",
        "references",
        "checklist.md",
      );
      const command = [
        "set -eu",
        'test "$(id -u)" = 10001',
        "test ! -r /config/config.yml",
        `test ! -r /proc/${process.pid}/environ`,
        "test ! -r /data/state/manager.sqlite",
        "grep -Eq '^NoNewPrivs:[[:space:]]+1$' /proc/self/status",
        "grep -Eq '^CapEff:[[:space:]]+0+$' /proc/self/status",
        `printf x >> ${file}`,
        "cat " + file,
        `cat '${reference}'`,
        ...(scenario === "cancel"
          ? [
              "setsid /bin/sh -c 'while :; do sleep 1; done' </dev/null >/dev/null 2>&1 &",
              'printf "%s" "$!" > detached.pid',
              "echo child-started",
            ]
          : []),
      ].join("\n");
      use("Bash", {
        command,
        description: "Exercise real unprivileged file and process effects",
      });
    } else if (["structured", "limited"].includes(scenario)) {
      const tool = toolNames.find((name) => name === "StructuredOutput");
      assert(tool, "SDK structured-output tool missing");
      use(
        tool,
        scenario === "limited" && !fixture.limitedResume
          ? { value: 123 }
          : { value: "validated" },
      );
    }
    if (["tools", "hostile"].includes(scenario) && results.length)
      assert(JSON.stringify(results).includes("OPERATOR_REFERENCE_CANARY"));
    if (initial) content.unshift({ type: "text", text: history.marker });
    if (
      results.length &&
      ![
        "limited",
        "malformed",
        "expiry",
        "mcp_write",
        "investigation_plan",
      ].includes(scenario)
    )
      assert(
        results.every((result) => !result.is_error),
        `Real tool failed: ${JSON.stringify(results)}`,
      );
    res.setHeader("content-type", "text/event-stream");
    const frame = (event, value) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
    frame("message_start", {
      type: "message_start",
      message: {
        id: `msg_${randomUUID()}`,
        type: "message",
        role: "assistant",
        model: "auto",
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
    content.forEach((block, index) => {
      frame("content_block_start", {
        type: "content_block_start",
        index,
        content_block:
          block.type === "text"
            ? { type: "text", text: "" }
            : { ...block, input: {} },
      });
      frame("content_block_delta", {
        type: "content_block_delta",
        index,
        delta:
          block.type === "text"
            ? { type: "text_delta", text: block.text }
            : {
                type: "input_json_delta",
                partial_json: JSON.stringify(block.input),
              },
      });
      frame("content_block_stop", { type: "content_block_stop", index });
    });
    frame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stop, stop_sequence: null },
      usage: { output_tokens: 5 },
    });
    frame("message_stop", { type: "message_stop" });
    res.end();
  } catch (error) {
    errors.push(error);
    res.destroy();
  }
}

export function verifyClaude(options) {
  return verifyAgent({
    ...options,
    driver: {
      sdk: "claude",
      version: "0.3.296",
      protocol: "anthropic_messages_sse",
      profile: {
        sdk: "claude",
        model: "auto",
        behaves_as: "claude-opus-4-8",
        effort: "xhigh",
      },
      respond,
    },
  });
}
