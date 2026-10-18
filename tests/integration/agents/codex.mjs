import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { verifyAgent } from "./conformance.mjs";

function strings(value) {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object")
    return Object.values(value).flatMap(strings);
  return [];
}

function send(res, output) {
  res.setHeader("content-type", "text/event-stream");
  const id = `resp_${randomUUID()}`;
  const response = {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "in_progress",
    output: [],
  };
  const frame = (type, data) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  frame("response.created", { response });
  output.forEach((item, output_index) => {
    frame("response.output_item.added", { output_index, item });
    if (item.type === "message") {
      frame("response.content_part.added", {
        item_id: item.id,
        output_index,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
      frame("response.output_text.delta", {
        item_id: item.id,
        output_index,
        content_index: 0,
        delta: item.content[0].text,
      });
      frame("response.output_text.done", {
        item_id: item.id,
        output_index,
        content_index: 0,
        text: item.content[0].text,
      });
    }
    frame("response.output_item.done", { output_index, item });
  });
  frame("response.completed", {
    response: {
      ...response,
      status: "completed",
      output,
      usage: {
        input_tokens: 20,
        input_tokens_details: { cached_tokens: 3 },
        output_tokens: 5,
        output_tokens_details: { reasoning_tokens: 2 },
        total_tokens: 25,
      },
    },
  });
  res.end();
}

export async function respond(req, res, fixture) {
  const { config, store, root, requests, histories, errors, mcpCredential } =
    fixture;
  try {
    assert.equal(req.url, "/v1/responses");
    assert.equal(req.headers.authorization, `Bearer ${config.proxy.key}`);
    assert(!req.headers.upgrade);
    let data = "";
    for await (const chunk of req) data += chunk;
    const body = JSON.parse(data);
    assert.equal(body.model, "gpt-5.5");
    const active = store.runs().findLast((run) => run.finished_at === null);
    const selected = store.snapshot(
      store.jobById(active.job_id).snapshot_digest,
    );
    assert.equal(
      body.reasoning.effort,
      selected.roles[active.role].profile.effort,
    );
    for (const secret of [config.proxy.key, config.github.token, mcpCredential])
      assert(!data.includes(secret));
    const text = strings(body.input).join("\n");
    const scenario =
      /"scenario":"([^"]+)"/.exec(text)?.[1] ??
      /"task":"(bootstrap_[^"]+)"/.exec(text)?.[1];
    assert(scenario, "Missing verbatim task context");
    assert(data.includes("OPERATOR_SYSTEM_CANARY"));
    assert(data.includes("OPERATOR_SKILL_CANARY"));
    assert(data.includes("OPERATOR_USER_CANARY"));
    assert(!data.includes("HOSTILE_CONTEXT_CANARY"));
    const tools = body.tools.flatMap((tool) =>
      tool.type === "namespace"
        ? tool.tools.map((child) => ({ ...child, namespace: tool.name }))
        : [tool],
    );
    const qualified = (tool) =>
      tool.namespace ? `${tool.namespace}__${tool.name}` : tool.name;
    const names = tools.map(qualified);
    assert(
      !body.tools.some((tool) => tool.type === "tool_search"),
      "Unexpected deferred tool discovery",
    );
    assert(
      !names.some((name) =>
        /spawn_agent|send_message|web_search|imagegen|plugin|js_repl/.test(
          name,
        ),
      ),
    );
    const previous = requests.filter(
      (request) => request.run === active.id,
    ).length;
    requests.push({ scenario, body, run: active.id });
    let history = histories.get(active.job_id);
    if (!history && scenario === "tools") {
      history = { marker: `prior_turn_${randomUUID()}`, run: active.id };
      histories.set(active.job_id, history);
    } else if (history && history.run !== active.id && !history.checked) {
      assert(text.includes(history.marker), "Resumed conversation was lost");
      history.checked = true;
    }
    const results = body.input.filter((item) =>
      ["function_call_output", "custom_tool_call_output"].includes(item.type),
    );
    const use = (name, args) => {
      assert(
        names.includes(name),
        `SDK did not advertise ${name}; advertised ${JSON.stringify(names)}`,
      );
      const tool = tools.find((tool) => qualified(tool) === name);
      const identity = {
        name: tool.name,
        ...(tool.namespace ? { namespace: tool.namespace } : {}),
      };
      return tool.type === "custom"
        ? {
            type: "custom_tool_call",
            id: `fc_${randomUUID()}`,
            call_id: `call_${randomUUID()}`,
            ...identity,
            input: args,
          }
        : {
            type: "function_call",
            id: `fc_${randomUUID()}`,
            call_id: `call_${randomUUID()}`,
            ...identity,
            arguments: JSON.stringify(args),
          };
    };
    const command = (cmd) =>
      use("exec_command", { cmd, max_output_tokens: 2000 });
    let output;
    if (scenario === "malformed") {
      res.setHeader("content-type", "text/event-stream");
      res.end("event: response.created\ndata: {not-json}\n\n");
      return;
    }
    if (scenario === "cancel" && previous) {
      fixture.held = true;
      return;
    }
    if (scenario === "bootstrap_environment") {
      if (!previous)
        output = use("exec_command", {
          cmd: fixture.environmentCommand,
          yield_time_ms: 30000,
          max_output_tokens: 2000,
        });
      else {
        const latest = strings(results.at(-1)).join("\n");
        const session = /Process running with session ID\s+(\d+)/i.exec(
          latest,
        )?.[1];
        if (session)
          output = use("write_stdin", {
            session_id: Number(session),
            chars: "",
            yield_time_ms: 30000,
            max_output_tokens: 2000,
          });
        else
          assert(/(?:^|\n)BOOTSTRAP_TESTS_PASSED(?:\n|$)/.test(latest), latest);
      }
    } else if (scenario === "crash") {
      output = command('pkill -ABRT -u "$(id -u)" -x codex');
    } else if (scenario === "output_review") {
      assert(data.includes("PAYLOAD_EVIDENCE_CANARY"));
      assert(!names.includes("exec_command"));
      assert(!names.some((name) => name.startsWith("mcp__")));
      if (!previous)
        output = use(
          "apply_patch",
          "*** Begin Patch\n*** Add File: output-review-owned\n+forbidden\n*** End Patch",
        );
      else
        assert(
          /reject|denied|approval|not allowed|not permitted|outside/i.test(
            strings(results).join("\n"),
          ),
          "Read-only output review did not deny a native write",
        );
    } else if (scenario === "review" && !previous) {
      output = command('test "$(id -u)" = 10002 && cat app.txt');
    } else if (
      ["mcp", "expiry", "cancel_mcp"].includes(scenario) &&
      !previous
    ) {
      output = use("mcp__context__read", {});
    } else if (scenario === "mcp" && previous === 1) {
      assert(strings(results).join("\n").includes("granted-read-effect"));
      const script = `import fs from 'node:fs';
        let pid=process.ppid,setting;
        for(let i=0;i<12&&!setting;i++){
          const args=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\\0');
          const raw=args.find(a=>a.startsWith('mcp_servers='));
          if(raw) setting=raw;
          else pid=Number(/^PPid:\\s+(\\d+)/m.exec(fs.readFileSync('/proc/'+pid+'/status','utf8'))[1]);
        }
        if(!setting) throw Error('no SDK descriptor');
        const url=JSON.parse(/"url"=("[^"]+")/.exec(setting)[1]);
        const env=fs.readFileSync('/proc/'+pid+'/environ','utf8').split('\\0');
        const auth=env.find(v=>v.startsWith('ORM_MCP_AUTH_0=')).slice('ORM_MCP_AUTH_0='.length);
        const r=await fetch(url,{method:'POST',headers:{authorization:'Bearer '+auth,'content-type':'application/json',accept:'application/json, text/event-stream','mcp-session-id':${JSON.stringify(fixture.downstreamId)}},body:JSON.stringify({jsonrpc:'2.0',id:99123,method:'tools/call',params:{name:'hidden',arguments:{}}})});
        const text=await r.text();
        if(r.ok&&!text.includes('"error"')&&!text.includes('"isError":true')) throw Error('raw grant bypass');
        fs.writeFileSync('raw-denied','yes');console.log('raw-denied');`;
      output = command(
        `/opt/orm-runtime/bin/node --input-type=module -e '${script.replaceAll("'", "'\\''")}'`,
      );
    } else if (["tools", "hostile", "cancel"].includes(scenario) && !previous) {
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
      output = command(
        [
          "set -eu",
          'test "$(id -u)" = 10001',
          "test ! -r /config/config.yml",
          `test ! -r /proc/${process.pid}/environ`,
          "test ! -r /data/state/manager.sqlite",
          'test -z "${ORM_RELAY_AUTH:-}${ORM_MCP_AUTH_0:-}${GH_TOKEN:-}${OPENAI_API_KEY:-}${INJECTED_ENV:-}"',
          "grep -Eq '^NoNewPrivs:[[:space:]]+1$' /proc/self/status",
          "grep -Eq '^CapEff:[[:space:]]+0+$' /proc/self/status",
          "printf x >> effects.txt",
          "cat effects.txt",
          `cat '${reference}'`,
          ...(scenario === "cancel"
            ? [
                "setsid /bin/sh -c 'while :; do sleep 1; done' </dev/null >/dev/null 2>&1 &",
                'printf "%s" "$!" > detached.pid',
                "echo child-started",
              ]
            : []),
        ].join("\n"),
      );
    }
    if (previous && ["tools", "hostile"].includes(scenario))
      assert(strings(results).join("\n").includes("OPERATOR_REFERENCE_CANARY"));
    const final = ["bootstrap_plan", "bootstrap_audit"].includes(scenario)
      ? JSON.stringify(fixture.bootstrap(scenario, text))
      : scenario === "structured"
        ? '{"value":"validated"}'
        : scenario === "invalid"
          ? '{"value":123}'
          : "fixture-completed";
    send(
      res,
      output
        ? [output]
        : [
            {
              type: "message",
              id: `msg_${randomUUID()}`,
              status: "completed",
              role: "assistant",
              phase: "final_answer",
              content: [
                {
                  type: "output_text",
                  text: (history ? history.marker + "\n" : "") + final,
                  annotations: [],
                },
              ],
            },
          ],
    );
  } catch (error) {
    errors.push(error);
    res.destroy();
  }
}

export function verifyCodex(options) {
  return verifyAgent({
    ...options,
    driver: {
      sdk: "codex",
      version: "0.162.1",
      protocol: "responses_http_sse",
      profile: { sdk: "codex", model: "gpt-5.5", effort: "xhigh" },
      respond,
    },
  });
}
