import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createConnection } from "node:net";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/repositories/store.ts";
import { ModelRelay } from "../src/services/model-relay.ts";
import { fixtureConfiguration, fixtureSnapshot } from "./fixtures.ts";
import { makeIssue } from "./fixtures/github.ts";
import { sdkVersions } from "../src/domain/agents.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup(
  sdk: "claude" | "codex" = "claude",
  budget = 10,
  credential = "relay-upstream-secret",
  bytes = 4096,
) {
  const requests: Array<{
    url: string | undefined;
    authorization: string | undefined;
    body: unknown;
    committed: number;
  }> = [];
  let handler:
    ((req: IncomingMessage, res: ServerResponse) => void) | undefined;
  const server = createServer(async (req, res) => {
    let bytes = "";
    for await (const chunk of req) bytes += chunk;
    requests.push({
      url: req.url,
      authorization: req.headers.authorization,
      body: JSON.parse(bytes),
      committed: JSON.parse(store.job(1)!.budget_json).model_requests,
    });
    if (handler) handler(req, res);
    else {
      res.setHeader("content-type", "application/json");
      res.end('{"count":3}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port,
    config = fixtureConfiguration();
  config.proxy.url = `http://127.0.0.1:${port}/v1`;
  config.proxy.key = "relay-upstream-secret";
  config.github.token = credential;
  const loaded = await fixtureSnapshot("model", config),
    root = await mkdtemp(join(tmpdir(), "orm-relay-"));
  const store = new Store(join(root, "state", "db.sqlite"));
  store.saveSnapshot(loaded.snapshot);
  const context = {
    ...makeIssue(1),
    state: "open" as const,
    comments: [],
    source: {
      sha: "a".repeat(40),
      tree_sha: "b".repeat(40),
      default_branch: "main",
    },
  };
  store.applyIssue(store.refreshIssue(1), context, loaded.snapshot);
  const job = store.job(1)!,
    lease = store.acquireLease(job.id, job.revision)!;
  const deadline = store.startRuntimeLease(lease, 60_000),
    relay = new ModelRelay(store, config.proxy.url, loaded.secrets);
  await relay.start();
  const controller = new AbortController();
  let available = true;
  const profile =
    sdk === "claude"
      ? { sdk: "claude" as const, model: "model", effort: "high" as const }
      : { sdk: "codex" as const, model: "model", effort: "high" as const };
  const grant = relay.authorize({
    lease,
    profile,
    deadline,
    requests: budget,
    bytes,
    signal: controller.signal,
    current: () => store.runtimeCurrent(lease),
    available: () => available,
  });
  cleanups.push(async () => {
    controller.abort();
    await relay.close();
    store.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true });
  });
  const post = (
    path: string,
    body: unknown = { model: "model" },
    signal?: AbortSignal,
  ) =>
    fetch(grant.url + path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${grant.authorization}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
  return {
    post,
    grant,
    relay,
    store,
    loaded,
    requests,
    controller,
    context,
    handler: (next: typeof handler) => {
      handler = next;
    },
    available: (next: boolean) => {
      available = next;
    },
  };
}

describe("scoped model relay", () => {
  it.each(
    (["claude", "codex"] as const).flatMap((sdk) =>
      (
        [
          "deadline",
          "transport",
          "runtime",
          "disconnect",
          "rejected",
          "rejected-prefix",
          "numeric-redactions",
          "sse",
          "sse-escaped",
          "sse-multiline-escaped",
          "sse-multiline-auth",
          "sse-fragmented",
          "sse-fragmented-escaped",
          "sse-fragmented-overlap",
          "sse-fragmented-unicode",
          "sse-fragmented-cross-block",
          "sse-fragmented-multiple",
          "sse-fragmented-complete-secondary",
          "sse-fragmented-error-event",
          "sse-fragmented-invalid-json",
          "sse-fragmented-plaintext",
          "sse-fragmented-local",
          "sse-fragmented-within-frame",
          "sse-fragmented-within-frame-long",
          "sse-fragmented-numeric-context",
          "sse-fragmented-partial",
          "rejected-malformed",
          "invalid-json",
          "client-json",
          "backpressure",
          "rejected-interrupted",
          "rejected-cancelled",
          "concurrent",
        ] as const
      ).map((mode) => ({ sdk, mode })),
    ),
  )("emits the actual $sdk relay failure cause for $mode", ({ sdk, mode }) => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import {createServer,ServerResponse} from 'node:http';
      import {mkdtemp,rm} from 'node:fs/promises';
      import {tmpdir} from 'node:os';
      import {join} from 'node:path';
      import {setTimeout as delay} from 'node:timers/promises';
      import {Store} from './src/repositories/store.ts';
      import {ModelRelay} from './src/services/model-relay.ts';
      import {fixtureConfiguration,fixtureSnapshot} from './tests/fixtures.ts';
      import {makeIssue} from './tests/fixtures/github.ts';
      const [mode,sdk]=process.argv.slice(1);
      const root=await mkdtemp(join(tmpdir(),'orm-relay-diagnostics-'));
      const reached=Promise.withResolvers();
      let requests=0;
      const server=createServer((req,res)=>{
        requests++; req.resume(); reached.resolve();
        if(mode.startsWith('sse-fragmented')) {
          const credential=['sse-fragmented-overlap','sse-fragmented-unicode','sse-fragmented-multiple','sse-fragmented-complete-secondary','sse-fragmented-error-event','sse-fragmented-invalid-json','sse-fragmented-plaintext','sse-fragmented-local','sse-fragmented-within-frame','sse-fragmented-within-frame-long','sse-fragmented-numeric-context','sse-fragmented-partial'].includes(mode)?config.github.token:config.proxy.key;
          const split=mode==='sse-fragmented-unicode'?credential.indexOf('😀')+1:mode==='sse-fragmented-within-frame-long'?credential.length-1:1;
          const event=(text,index,refusal)=>sdk==='claude'?{type:'content_block_delta',index,delta:{type:'text_delta',text,refusal}}:{type:'response.output_text.delta',output_index:index,content_index:0,delta:text,refusal};
          const frame=(value,index)=>{
            let data=JSON.stringify(value);
            if(mode==='sse-fragmented-escaped') data=data.replace(/[A-Za-z-]/g,char=>String.fromCharCode(92)+'u'+char.charCodeAt(0).toString(16).padStart(4,'0'));
            return 'event: credential-frame\\nid: frame-'+index+'\\ndata: '+data+'\\n\\n';
          };
          res.setHeader('content-type','text/event-stream');
          const text=credential.slice(split)+'; Provider streaming failure 100; public context 0 and 1. https://storage.invalid/file?sig=signed-canary';
          let first=frame(event(credential.slice(0,split),0,mode==='sse-fragmented-multiple'?config.proxy.key.slice(0,1):undefined),1);
          let second=frame(event(text,mode==='sse-fragmented-cross-block'?1:0,mode==='sse-fragmented-multiple'?config.proxy.key.slice(1)+'; Other public failure reason':['sse-fragmented-complete-secondary','sse-fragmented-local'].includes(mode)?config.proxy.key:undefined),mode==='sse-fragmented-local'?3:2);
          if(mode==='sse-fragmented-error-event') second='event: error\\n'+second;
          if(mode==='sse-fragmented-invalid-json') second=second.slice(0,-4)+'\\n\\n';
          if(mode==='sse-fragmented-plaintext') second='id: frame-2\\ndata: '+text+'\\n\\n';
          if(mode==='sse-fragmented-local') first+=frame(event('public interruption context',1),2);
          if(['sse-fragmented-within-frame','sse-fragmented-within-frame-long'].includes(mode)) {
            first='';
            const value=event(credential.slice(0,split),0);
            const target=sdk==='claude'?value.delta:value;
            target.arguments=text;target.refusal=config.proxy.key;
            second=frame(value,2);
          }
          if(mode==='sse-fragmented-numeric-context') {
            const value=event(text,0,config.proxy.key), target=sdk==='claude'?value.delta:value;
            const slash=String.fromCharCode(92);
            target.message='Provider ordinary value 0; pattern "'+slash+'u0030'+slash+'u0031"; invalid "'+slash+'q"';target.content='Provider ordinary value 1';
            second=frame(value,2);
          }
          if(mode==='sse-fragmented-partial') {
            const slash=String.fromCharCode(92), escaped=credential.slice(split).split('').map(char=>slash+'u'+char.charCodeAt(0).toString(16).padStart(4,'0')).join('');
            second='event: credential-frame\\nid: frame-2\\n: Provider streaming failure 100; public context 0 and 1\\ndata: {"text":"'+escaped.slice(0,-3)+'\\n\\n';
          }
          res.end(first+second);
        }
        if(mode==='backpressure') {
          res.setHeader('content-type','text/event-stream');
          const text='validated-payload-canary '+'x'.repeat(512000);
          const value=sdk==='claude'?{type:'content_block_delta',index:0,delta:{type:'text_delta',text}}:{type:'response.output_text.delta',output_index:0,content_index:0,delta:text};
          res.end(('data: '+JSON.stringify(value)+'\\n\\n').repeat(48));
        }
        if(mode==='transport') req.socket.destroy();
        if(mode==='runtime') {
          res.setHeader('content-type','application/json');
          res.end(JSON.stringify({error:{message:'provider-private-detail'}}));
        }
        if(mode==='rejected' || mode==='numeric-redactions') {
          res.writeHead(403,{'content-type':'application/json','x-request-id':'model-provider-100'});
          res.end(JSON.stringify({error:{message:'Provider denied model request 100',code:'policy_denied'},authorization:'provider-auth-canary'}));
        }
        if(mode==='rejected-prefix') {
          const opening='{"error":{"message":"Provider denied model request 100; context 0 and 1. ',credential=config.proxy.key;
          res.writeHead(403,{'content-type':'application/json','x-request-id':'model-provider-100'});
          res.end(opening+'x'.repeat(4096-credential.length+1-Buffer.byteLength(opening))+credential+'"}}');
        }
        if(mode==='rejected-malformed') {
          const slash=String.fromCharCode(92), encoded=config.proxy.key.split('').map(char=>slash+'u'+char.charCodeAt(0).toString(16).padStart(4,'0')).join('');
          res.writeHead(403,{'content-type':'application/json'});
          res.end('{"error":{"message":"Provider denied model request 100; '+encoded+'; public reason 0 and 1 '+slash);
        }
        if(mode==='sse') {
          res.setHeader('content-type','text/event-stream');
          res.end('event: error\\ndata: {"error":{"message":"Provider streaming failure 100"}}\\n\\n');
        }
        if(mode==='sse-escaped' || mode==='sse-multiline-escaped') {
          res.setHeader('content-type','text/event-stream');
          let data=JSON.stringify({error:{message:'Provider streaming failure 100 https://storage.invalid/file?sig=signed-canary'}}).replaceAll('/',String.fromCharCode(92)+'/');
          if(mode==='sse-multiline-escaped') data=data.replace('{"error":','{"error":\\ndata: ');
          res.end('event: error\\ndata: '+data+'\\n\\n');
        }
        if(mode==='sse-multiline-auth') {
          res.setHeader('content-type','text/event-stream');
          const data=JSON.stringify({error:{message:'Provider streaming failure 100',authorization:'Bearer private-auth-canary','set-cookie':['session=private-cookie-canary']},detail:'provider context after authentication'}).replace('"authorization":','"authorization":\\ndata: ');
          res.end('event: error\\ndata: '+data+'\\n\\n');
        }
        if(mode==='invalid-json') {res.setHeader('content-type','application/json');res.end('invalid provider JSON 100');}
        if(mode==='rejected-interrupted' || mode==='rejected-cancelled') {
          res.writeHead(403,{'content-type':'application/json'});
          res.write('{"error":{"message":"Provider body failure 100"');
          if(mode==='rejected-interrupted') setTimeout(()=>res.destroy(),20);
        }
        if(mode==='concurrent') {
          res.writeHead(403,{'content-type':'application/json'});
          res.end(JSON.stringify({error:{message:'Provider concurrent request '+requests+' denied'}}));
        }

      });
      await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
      const config=fixtureConfiguration();
      if(mode==='sse-fragmented-overlap') config.github.token=config.proxy.key+'-extended';
      if(mode==='sse-fragmented-unicode') config.github.token='token-😀-credential';
      if(mode==='sse-fragmented-numeric-context') {config.proxy.key='0-provider-key';config.redaction_values=['0','1'];}
      if(mode==='numeric-redactions' || mode==='rejected-prefix') config.redaction_values=['0','1'];
      config.proxy.url='http://127.0.0.1:'+server.address().port+'/v1';
      const loaded=await fixtureSnapshot('private-model-canary',config);
      const store=new Store(join(root,'state.sqlite'));
      store.saveSnapshot(loaded.snapshot);
      store.applyIssue(store.refreshIssue(1),{...makeIssue(1),comments:[],source:{sha:'a'.repeat(40),tree_sha:'b'.repeat(40),default_branch:'main'}},loaded.snapshot);
      const lease=store.acquireLease(1,store.job(1).revision);
      store.startRuntimeLease(lease,60000);
      const caller=new AbortController(),client=new AbortController();
      const relay=new ModelRelay(store,config.proxy.url,loaded.secrets);
      const originalWrite=ServerResponse.prototype.write;
      let waitingResponse,backpressureWaiting;
      try {
        await relay.start();
        const grant=relay.authorize({lease,profile:{sdk,model:'private-model-canary',effort:'high'},deadline:Date.now()+(mode==='deadline'?150:10000),requests:10,bytes:mode==='backpressure'?32*1024*1024:4096,signal:caller.signal,current:()=>store.runtimeCurrent(lease),context:{run_id:'relay-diagnostics',job_id:1,revision:1,role:'audit'}});
        if(mode==='backpressure') ServerResponse.prototype.write=function(...args) {
          const accepted=Reflect.apply(originalWrite,this,args);
          if(this.socket?.localPort===Number(new URL(grant.url).port) && !accepted) waitingResponse=this;
          return accepted;
        };
        const call=()=>fetch(grant.url+(sdk==='claude'?'/messages':'/responses'),{method:'POST',headers:{authorization:'Bearer '+grant.authorization,'content-type':'application/json'},body:mode==='client-json'?'{':JSON.stringify({model:'private-model-canary'}),signal:client.signal}).then(async response=>{
          if(mode==='backpressure'){await delay(500);backpressureWaiting=Boolean(waitingResponse?.writableNeedDrain);client.abort();await response.body?.cancel().catch(()=>{});return null;}
          await response.text();return response.status;
        },error=>{if(!['disconnect','rejected-cancelled'].includes(mode))throw error;return null});
        const responses=mode==='concurrent'?[call(),call()]:[call()];
        if(mode!=='client-json') await reached.promise;
        if(mode==='disconnect') client.abort();
        if(mode==='rejected-cancelled') {await delay(80);client.abort();}
        const status=(await Promise.all(responses))[0];
        await delay(30);
        console.log(JSON.stringify({status,requests,charged:JSON.parse(store.job(1).budget_json).model_requests,caller_aborted:caller.signal.aborted,...(mode==='backpressure'?{backpressure_waiting:backpressureWaiting}:{})}));
      } finally {
        ServerResponse.prototype.write=originalWrite;
        caller.abort(); await relay.close(); store.close(); server.closeAllConnections();
        await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
        await rm(root,{recursive:true});
      }
    `,
        mode,
        sdk,
      ],
      {
        cwd: new URL("../", import.meta.url),
        encoding: "utf8",
        timeout: 10000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    if (mode === "client-json") {
      expect(JSON.parse(result.stdout.trim())).toEqual({
        status: 502,
        requests: 0,
        charged: 0,
        caller_aborted: false,
      });
      const records = result.stderr
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line));
      expect(
        records.find((row) => row.event === "model.request.failed").cause,
      ).toBe("request_invalid");
      expect(records.some((row) => row.event === "api.request.started")).toBe(
        false,
      );
      return;
    }
    expect(JSON.parse(result.stdout.trim())).toEqual({
      status: ["disconnect", "rejected-cancelled", "backpressure"].includes(
        mode,
      )
        ? null
        : 502,
      requests: mode === "concurrent" ? 2 : 1,
      charged: mode === "concurrent" ? 2 : 1,
      caller_aborted: false,
      ...(mode === "backpressure" ? { backpressure_waiting: true } : {}),
    });
    const logs = result.stderr
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line));
    const started = logs.find((log) => log.event === "model.request.started"),
      failed = logs.find(
        (log) =>
          log.event === "model.request.failed" &&
          log.request_id === started.request_id,
      );
    expect(started).toMatchObject({
      level: "info",
      run_id: "relay-diagnostics",
      job_id: 1,
      revision: 1,
      role: "audit",
      sdk,
      sdk_version: sdkVersions[sdk],
      route: sdk === "claude" ? "/v1/messages" : "/v1/responses",
    });
    expect(failed).toMatchObject({
      ...started,
      event: "model.request.failed",
      level: "error",
      outcome: "failed",
      cause: {
        deadline: "deadline_exceeded",
        transport: "upstream_transport_failed",
        runtime: "relay_response_invalid",
        disconnect: "request_cancelled",
        rejected: "upstream_rejected",
        "rejected-prefix": "upstream_rejected",
        "numeric-redactions": "upstream_rejected",
        sse: "relay_response_invalid",
        "sse-escaped": "relay_response_invalid",
        "sse-multiline-escaped": "relay_response_invalid",
        "sse-multiline-auth": "relay_response_invalid",
        "sse-fragmented": "relay_response_invalid",
        "sse-fragmented-escaped": "relay_response_invalid",
        "sse-fragmented-overlap": "relay_response_invalid",
        "sse-fragmented-unicode": "relay_response_invalid",
        "sse-fragmented-cross-block": "relay_response_invalid",
        "sse-fragmented-multiple": "relay_response_invalid",
        "sse-fragmented-complete-secondary": "relay_response_invalid",
        "sse-fragmented-error-event": "relay_response_invalid",
        "sse-fragmented-invalid-json": "relay_response_invalid",
        "sse-fragmented-plaintext": "relay_response_invalid",
        "sse-fragmented-local": "relay_response_invalid",
        "sse-fragmented-within-frame": "relay_response_invalid",
        "sse-fragmented-within-frame-long": "relay_response_invalid",
        "sse-fragmented-numeric-context": "relay_response_invalid",
        "sse-fragmented-partial": "relay_response_invalid",
        "rejected-malformed": "upstream_rejected",
        backpressure: "request_cancelled",
        "invalid-json": "relay_response_invalid",
        "rejected-interrupted": "upstream_rejected",
        "rejected-cancelled": "request_cancelled",
        concurrent: "upstream_rejected",
      }[mode],
    });
    expect(failed.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(failed.recovery).toMatch(/Verify.*before retrying/);
    expect(
      logs.filter((log) => log.event === "model.request.failed"),
    ).toHaveLength(mode === "concurrent" ? 2 : 1);
    const apiFailure = logs.find(
      (log) =>
        log.event === "api.request.failed" &&
        log.request_id === started.request_id,
    );
    expect(apiFailure).toMatchObject({
      provider: "model",
      job_id: 1,
      role: "audit",
      request_id: started.request_id,
    });
    if (mode === "concurrent") {
      const starts = logs.filter(
        (log) => log.event === "model.request.started",
      );
      expect(new Set(starts.map((log) => log.request_id)).size).toBe(2);
      for (const start of starts) {
        expect(
          logs.some(
            (log) =>
              log.event === "api.request.failed" &&
              log.request_id === start.request_id,
          ),
        ).toBe(true);
        expect(
          logs.some(
            (log) =>
              log.event === "model.request.failed" &&
              log.request_id === start.request_id,
          ),
        ).toBe(true);
        expect(
          logs
            .filter(
              (log) =>
                log.request_id === start.request_id &&
                log.detail_kind === "body",
            )
            .map((log) => log.content)
            .join(""),
        ).toContain("Provider concurrent request");
      }
    }
    if (["rejected-interrupted", "rejected-cancelled"].includes(mode)) {
      const detail = logs
        .filter((log) => log.detail_kind === "read_cause")
        .map((log) => log.content)
        .join("");
      expect(detail).toMatch(/Abort|terminated|aborted|cancel/i);
      expect(
        logs.some((log) =>
          ["read_failed", "cancelled"].includes(log.capture_state),
        ),
      ).toBe(true);
    }
    const body = logs
      .filter(
        (log) =>
          log.event === "api.response.detail" && log.detail_kind === "body",
      )
      .map((log) => log.content)
      .join("");
    if (mode === "runtime") expect(body).toContain("provider-private-detail");
    if (mode === "rejected" || mode === "numeric-redactions") {
      expect(apiFailure.status).toBe(403);
      expect(body).toContain("Provider denied model request 100");
      expect(result.stderr).not.toContain("provider-auth-canary");
    }
    if (mode === "rejected-prefix") {
      expect(apiFailure.status).toBe(403);
      expect(body).toContain(
        "Provider denied model request 100; context 0 and 1.",
      );
      expect(body).toContain("[credential prefix excluded]");
      expect(result.stderr).not.toContain(
        fixtureConfiguration().proxy.key.slice(0, -1),
      );
      expect(logs.some((log) => log.capture_state === "byte_limit")).toBe(true);
    }
    if (mode.startsWith("sse"))
      expect(body).toContain("Provider streaming failure 100");
    if (mode === "rejected-malformed") {
      expect(apiFailure.status).toBe(403);
      expect(body).toContain("Provider denied model request 100");
      expect(body).toContain("public reason 0 and 1");
      expect(body).not.toContain("\\u0070\\u0072\\u006f\\u0078\\u0079");
    }
    if (
      [
        "sse-fragmented-invalid-json",
        "sse-fragmented-plaintext",
        "sse-fragmented-partial",
      ].includes(mode)
    ) {
      expect(body).toContain("[credential fragment excluded]");
      expect(body).toContain("public context 0 and 1");
      expect(body).toContain("id: frame-2");
      expect(body).not.toContain(
        fixtureConfiguration().github.token.slice(1, -1),
      );
    } else if (mode.startsWith("sse-fragmented")) {
      const frame = JSON.parse(
        body
          .split("\n")
          .find((line) => line.startsWith("data:"))!
          .slice(5),
      );
      const text = [
        "sse-fragmented-within-frame",
        "sse-fragmented-within-frame-long",
      ].includes(mode)
        ? sdk === "claude"
          ? frame.delta.arguments
          : frame.arguments
        : sdk === "claude"
          ? frame.delta.text
          : frame.delta;
      expect(text).toMatch(
        /^\[credential fragment excluded\]; Provider streaming failure 100;/,
      );
      expect(text).toContain("public context 0 and 1");
      expect(body).toContain(
        mode === "sse-fragmented-local" ? "id: frame-3" : "id: frame-2",
      );
      expect(text).not.toContain("-extended");
      if (mode === "sse-fragmented-within-frame-long")
        expect(body).not.toContain(
          fixtureConfiguration().github.token.slice(0, -1),
        );
      if (mode === "sse-fragmented-numeric-context") {
        const target = sdk === "claude" ? frame.delta : frame;
        expect(target.message).toBe(
          String.raw`Provider ordinary value 0; pattern "\u0030\u0031"; invalid "\q"`,
        );
        expect(target.content).toBe("Provider ordinary value 1");
      }
      if (mode === "sse-fragmented-multiple") {
        const refusal = sdk === "claude" ? frame.delta.refusal : frame.refusal;
        expect(refusal).toBe(
          "[credential fragment excluded]; Other public failure reason",
        );
        expect(result.stderr).not.toContain("roxy-fixture-key");
      }
    }
    if (mode === "backpressure") {
      expect(body).toBe("");
      expect(result.stderr).not.toContain("validated-payload-canary");
    }
    if (mode.includes("escaped")) {
      expect(body).toContain("[signed URL excluded]");
      expect(result.stderr).not.toContain("signed-canary");
    }
    if (mode === "sse-multiline-auth") {
      expect(body).toContain("provider context after authentication");
      expect(result.stderr).not.toContain("private-auth-canary");
      expect(result.stderr).not.toContain("private-cookie-canary");
    }
    if (mode === "invalid-json")
      expect(body).toContain("invalid provider JSON 100");
    for (const secret of [
      "github-fixture-token",
      "proxy-fixture-key",
      "private-model-canary",
      "127.0.0.1",
    ])
      expect(result.stdout + result.stderr).not.toContain(secret);
  });
  it.each(["claude", "codex"] as const)(
    "preserves %s SSE bytes under a paused, slow consumer",
    async (sdk) => {
      const f = await setup(sdk, 10, "relay-upstream-secret", 32 * 1024 * 1024);
      const frame =
        "data: " +
        JSON.stringify({ delta: { text: "x".repeat(32768) } }) +
        "\n\n";
      const count = 768;
      let backpressure = 0;
      f.handler(async (_req, res) => {
        res.setHeader("content-type", "text/event-stream");
        for (let index = 0; index < count; index++)
          if (!res.write(frame)) {
            backpressure++;
            await once(res, "drain");
          }
        res.end();
      });
      const response = await f.post(
        sdk === "claude" ? "/messages" : "/responses",
      );
      const reader = response.body!.getReader();
      await delay(100);
      const actual = createHash("sha256"),
        expected = createHash("sha256");
      let received = 0;
      for (let index = 0; index < count; index++) expected.update(frame);
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        actual.update(next.value);
        received += next.value.length;
        await delay(1);
      }
      expect(received).toBe(Buffer.byteLength(frame) * count);
      expect(actual.digest("hex")).toBe(expected.digest("hex"));
      expect(backpressure).toBeGreaterThan(0);
    },
    30000,
  );
  it("rejects an actual WebSocket upgrade", async () => {
    const f = await setup("codex"),
      url = new URL(f.grant.url);
    const socket = createConnection({
      host: "127.0.0.1",
      port: Number(url.port),
    });
    const response = await new Promise<string>((resolve, reject) => {
      let output = "";
      socket.on("data", (chunk) => {
        output += chunk;
      });
      socket.on("error", reject);
      socket.on("close", () => resolve(output));
      socket.on("connect", () =>
        socket.write(
          `GET /v1/responses HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nAuthorization: Bearer ${f.grant.authorization}\r\n\r\n`,
        ),
      );
    });
    expect(response).toContain("403 Forbidden");
    expect(f.requests).toHaveLength(0);
  });
  it("streams split SSE frames using only upstream authentication", async () => {
    const f = await setup();
    f.handler((_req, res) => {
      res.setHeader("content-type", "text/event-stream");
      res.write('event: message_start\ndata: {"type":"message_');
      setTimeout(
        () =>
          res.end(
            'start","message":{"id":"m"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
          ),
        5,
      );
    });
    const response = await f.post("/messages");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("message_stop");
    expect(f.requests).toMatchObject([
      {
        url: "/v1/messages",
        authorization: "Bearer relay-upstream-secret",
        body: { model: "model", output_config: { effort: "high" } },
        committed: 1,
      },
    ]);
    expect(f.grant.authorization).not.toBe("relay-upstream-secret");
    expect((await f.post("/messages/count_tokens")).status).toBe(200);
  });
  it.each([
    {
      sdk: "claude",
      credential: "relay-upstream-secret",
      chunks: ["relay-upstream-", "secret"],
    },
    {
      sdk: "codex",
      credential: "relay-upstream-secret",
      chunks: ["relay-upstream-", "secret"],
    },
    {
      sdk: "claude",
      credential: "ababababac",
      chunks: ["ababa", "baba", "bac"],
    },
    {
      sdk: "codex",
      credential: "token-😀-credential",
      chunks: ["token-\ud83d", "\ude00-credential"],
    },
    {
      sdk: "claude",
      credential: "relay-upstream-secret",
      chunks: ["relay-upstream-", "secret"],
      initial: true,
    },
    {
      sdk: "codex",
      credential: "relay-upstream-secret",
      chunks: ["relay-upstream-", "secret"],
      crossBlocks: true,
    },
  ] as const)(
    "withholds fragmented $sdk credentials before forwarding their prefixes ($credential)",
    async (test) => {
      const f = await setup(test.sdk, 10, test.credential, 16384);
      let source: ServerResponse | undefined;
      const event = (text: string, index = 0) =>
        test.sdk === "claude"
          ? {
              type: "content_block_delta",
              index,
              delta: { type: "text_delta", text },
            }
          : {
              type: "response.output_text.delta",
              output_index: index,
              content_index: 0,
              delta: text,
            };
      const frame = (value: unknown) =>
        "data: " + JSON.stringify(value) + "\n\n";
      const content = (output: string) =>
        output
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => {
            const value = JSON.parse(line.slice(5)) as {
              delta?: string | { text?: string };
              content_block?: { text?: string };
            };
            return typeof value.delta === "string"
              ? value.delta
              : (value.delta?.text ?? value.content_block?.text ?? "");
          })
          .join("");
      f.handler((_req, res) => {
        source = res;
        res.setHeader("content-type", "text/event-stream");
        res.write(frame(event("safe first.")));
      });
      const response = await f.post(
          test.sdk === "claude" ? "/messages" : "/responses",
          undefined,
          AbortSignal.timeout(2000),
        ),
        reader = response.body!.getReader(),
        first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain("safe first.");
      const initial = "initial" in test && test.initial;
      source!.write(
        frame(
          initial
            ? {
                type: "content_block_start",
                index: 0,
                content_block: { type: "text", text: test.chunks[0] },
              }
            : event(test.chunks[0]),
        ),
      );
      const crossBlocks = "crossBlocks" in test && test.crossBlocks;
      if (!crossBlocks) source!.write(frame(event("unrelated channel", 1)));
      for (const text of test.chunks.slice(1))
        source!.write(frame(event(text, crossBlocks ? 1 : 0)));
      source!.end();
      let output = new TextDecoder().decode(first.value);
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        output += new TextDecoder().decode(next.value);
      }
      expect(output).toContain("relay_error");
      expect(content(output)).not.toContain(test.chunks[0]);
      expect(content(output)).not.toContain(test.credential);
      expect(f.requests).toHaveLength(1);
      f.handler((_req, res) => {
        res.setHeader("content-type", "text/event-stream");
        res.write(frame(event("safe first.")));
        res.write(
          frame(
            initial
              ? {
                  type: "content_block_start",
                  index: 0,
                  content_block: { type: "text", text: test.chunks[0] },
                }
              : event(test.chunks[0]),
          ),
        );
        if (!crossBlocks) res.write(frame(event("unrelated channel", 1)));
        for (const text of test.chunks.slice(1, -1))
          res.write(frame(event(text, crossBlocks ? 1 : 0)));
        res.end(frame(event("benign tail.", crossBlocks ? 1 : 0)));
      });
      const benign = await f.post(
          test.sdk === "claude" ? "/messages" : "/responses",
        ),
        benignOutput = await benign.text();
      expect(benign.status).toBe(200);
      expect(benignOutput).not.toContain("relay_error");
      expect(content(benignOutput)).toContain(test.chunks[0]);
      expect(f.requests).toHaveLength(2);
    },
  );
  it.each([["relay-upstream-", " ordinary text"], ["relay-upstream-"]])(
    "preserves benign prefixes through divergence or EOF: %s",
    async (...chunks) => {
      const f = await setup();
      f.handler((_req, res) => {
        res.setHeader("content-type", "text/event-stream");
        for (const text of chunks)
          res.write(
            "data: " +
              JSON.stringify({
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text },
              }) +
              "\n\n",
          );
        res.end();
      });
      const response = await f.post("/messages"),
        output = await response.text();
      expect(response.status).toBe(200);
      for (const text of chunks) expect(output).toContain(text);
      expect(output).not.toContain("relay_error");
    },
  );
  it("bounds held SSE data and per-field matcher state", async () => {
    const f = await setup();
    f.handler((_req, res) => {
      res.setHeader("content-type", "text/event-stream");
      res.write('data: {"delta":"relay-upstream-"}\n\n');
      for (let index = 0; index < 100; index++)
        res.write('data: {"message":"' + "x".repeat(100) + '"}\n\n');
      res.end();
    });
    const output = await (await f.post("/messages")).text();
    expect(output).not.toContain("relay-upstream-");
    expect(output).toContain("relay_error");
    f.handler((_req, res) => {
      res.setHeader("content-type", "text/event-stream");
      res.end(
        "data: " +
          JSON.stringify({
            content: Array.from({ length: 100 }, () => ({ text: "ordinary" })),
          }) +
          "\n\n",
      );
    });
    const response = await f.post("/messages");
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("relay_error");
  });
  it.each(["/responses", "/responses/compact"])(
    "supports Codex HTTP route %s and rejects cross-profile requests",
    async (path) => {
      const f = await setup("codex");
      expect((await f.post(path)).status).toBe(200);
      expect((await f.post("/messages")).status).toBe(403);
      expect((await f.post(path, { model: "other" })).status).toBe(403);
      expect(
        (await f.post(path, { model: "model", reasoning: { effort: "low" } }))
          .status,
      ).toBe(403);
      expect(
        (await f.post(path, { model: "model", base_url: "http://other" }))
          .status,
      ).toBe(403);
      expect(f.requests).toHaveLength(1);
    },
  );
  it.each(["claude", "codex"] as const)(
    "enforces %s effort on generation requests before forwarding",
    async (sdk) => {
      const f = await setup(sdk),
        path = sdk === "claude" ? "/messages" : "/responses",
        setting = sdk === "claude" ? "output_config" : "reasoning";
      expect((await f.post(path)).status).toBe(200);
      expect(f.requests[0].body).toEqual({
        model: "model",
        [setting]: { effort: "high" },
      });
      expect(
        (await f.post(path, { model: "model", [setting]: { effort: "low" } }))
          .status,
      ).toBe(403);
      expect(
        (await f.post(path, { model: "model", [setting]: "high" })).status,
      ).toBe(403);
      expect(
        (await f.post(path, { model: "model", [setting]: { effort: "high" } }))
          .status,
      ).toBe(200);
      expect(f.requests).toHaveLength(2);
    },
  );
  it("commits concurrent request reservations before forwarding and never refunds failures", async () => {
    const f = await setup("claude", 2);
    f.handler((_req, res) => {
      res.writeHead(500);
      res.end("relay-upstream-secret");
    });
    const responses = await Promise.all([
      f.post("/messages"),
      f.post("/messages/count_tokens"),
      f.post("/messages"),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([429, 502, 502]);
    expect(f.requests).toHaveLength(2);
    expect(f.requests.every((r) => r.committed >= 1)).toBe(true);
    expect(JSON.parse(f.store.job(1)!.budget_json).model_requests).toBe(2);
    for (const response of responses)
      expect(await response.text()).not.toContain("relay-upstream-secret");
  });
  it("rejects redirects, secret-bearing SSE errors, oversized input and forbidden paths", async () => {
    const f = await setup();
    f.handler((_req, res) => {
      res.writeHead(302, { location: f.grant.url + "/messages" });
      res.end();
    });
    expect((await f.post("/messages")).status).toBe(502);
    expect(f.requests).toHaveLength(1);
    f.handler((_req, res) => {
      res.setHeader("content-type", "text/event-stream");
      res.end(
        'event: error\ndata: {"error":{"message":"relay-upstream-secret"}}\n\n',
      );
    });
    expect(await (await f.post("/messages")).text()).not.toContain(
      "relay-upstream-secret",
    );
    expect(
      (await f.post("/messages", { model: "model", input: "x".repeat(5000) }))
        .status,
    ).toBe(413);
    expect((await f.post("/models")).status).toBe(403);
    expect((await f.post("/messages?target=elsewhere")).status).toBe(403);
    expect(
      (
        await fetch(f.grant.url + "/messages", {
          headers: { authorization: `Bearer ${f.grant.authorization}` },
        })
      ).status,
    ).toBe(403);
  });
  it("keeps authorization usable after a nested-review suspension", async () => {
    const f = await setup();
    f.available(false);
    expect((await f.post("/messages")).status).toBe(409);
    await delay(300);
    f.available(true);
    expect((await f.post("/messages")).status).toBe(200);
    expect(f.requests).toHaveLength(1);
  });
  it.each(["cancellation", "revision", "disconnect"])(
    "aborts upstream streaming on %s",
    async (mode) => {
      const f = await setup();
      let closed = false;
      f.handler((_req, res) => {
        res.on("close", () => {
          closed = true;
        });
        res.setHeader("content-type", "text/event-stream");
        res.write('data: {"type":"message_start"}\n\n');
      });
      const client = new AbortController(),
        response = await f.post("/messages", { model: "model" }, client.signal);
      const reader = response.body!.getReader();
      await reader.read();
      if (mode === "cancellation") f.controller.abort();
      if (mode === "disconnect") client.abort();
      if (mode === "revision") {
        f.store.applyIssue(
          f.store.refreshIssue(1),
          { ...f.context, body: "changed" },
          f.loaded.snapshot,
        );
      }
      const until = performance.now() + 2000;
      while (!closed && performance.now() < until) await delay(10);
      expect(closed).toBe(true);
      await reader.cancel().catch(() => {});
      if (mode !== "disconnect")
        expect((await f.post("/messages")).status).toBe(401);
    },
  );
  it("expires short-lived grants and rejects invalid authentication", async () => {
    const f = await setup();
    const short = f.relay.authorize({
      lease: f.store.leases()[0].token,
      profile: { sdk: "claude", model: "model", effort: "high" },
      deadline: Date.now() + 20,
      requests: 10,
      bytes: 4096,
      signal: f.controller.signal,
      current: () => true,
    });
    await delay(40);
    expect(
      (
        await fetch(short.url + "/messages", {
          method: "POST",
          headers: { authorization: `Bearer ${short.authorization}` },
          body: '{"model":"model"}',
        })
      ).status,
    ).toBe(401);
    f.grant.revoke();
    expect((await f.post("/messages")).status).toBe(401);
    expect(
      (
        await fetch(f.grant.url + "/messages", {
          method: "POST",
          headers: { authorization: "Bearer unknown" },
          body: '{"model":"model"}',
        })
      ).status,
    ).toBe(401);
  });
});
