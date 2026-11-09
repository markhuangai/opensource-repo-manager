import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createApiDiagnostics } from "../src/logging/api.ts";
import { createKnownSecretChecker } from "../src/logging/redact.ts";

function run(mode: string, credential = "actual-credential-canary") {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import {createServer} from 'node:http';
    import {createGitHubClient} from './src/adapters/github/client.ts';
    import {OctokitWriter} from './src/adapters/github/writer.ts';
    import {createApiDiagnostics} from './src/logging/api.ts';
    import {createKnownSecretChecker} from './src/logging/redact.ts';
    const mode=process.argv[1], requests=[];
    const credential=process.argv[2]??'actual-credential-canary';
    const credentials=createKnownSecretChecker([credential]);
    const diagnostics=createApiDiagnostics({...credentials,redact:createKnownSecretChecker(['0','1','Denied']).redact,redactCredentials:credentials.redact},{repository:'owner/repo',issue_number:22});
    const message='Denied for issue 22 with status 403; request 100. '+('雪\\n"'.repeat(mode==='large'?12000:1))+' actual-credential-canary';
    const literalMessage='Provider literal pattern "'+String.fromCharCode(92)+'u0030'+String.fromCharCode(92)+'u0031" and invalid "'+String.fromCharCode(92)+'q"; public context 0 and 1.';
    const headerMessage='Provider access denied with context 0 and 1\\nAuthorization: Bearer header-auth-canary\\nProxy-Authorization: Basic header-proxy-canary\\nCookie: session=header-cookie-canary\\nSet-Cookie: session=header-set-cookie-canary; HttpOnly\\nX-Api-Key: unregistered-xapi-canary\\nApi-Key: unregistered-api-canary\\nProvider key link https://storage.invalid/file?x-api-key=url-api-canary\\nProvider inline authentication context 100 request sent Authorization: Bearer inline-auth-canary\\nProvider reason ends';
    const server=createServer((req,res)=>{
      requests.push(req.method+' '+req.url);req.resume();
      res.setHeader('content-type','application/json');res.setHeader('x-github-request-id','provider-request-100');
      res.setHeader('x-accepted-github-permissions','issues=write');
      res.setHeader('authorization','server-authorization-canary');
      if(mode==='transport') {req.socket.destroy();return;}
      if(mode==='literal-escapes') {res.writeHead(403,{'content-type':'text/plain'});res.end(literalMessage);return;}
      if(mode.startsWith('malformed-')) {
        const slash=String.fromCharCode(92), encoded=credential.split('').map(char=>slash+'u'+char.charCodeAt(0).toString(16).padStart(4,'0')).join('');
        let body='{"message":"Provider malformed denial 100; ';
        if(mode==='malformed-internal') body+='invalid escape '+slash+'q before '+encoded+'; public reason 0 and 1"}';
        else if(mode==='malformed-prefix') body+=encoded.slice(0,-3);
        else if(mode==='malformed-auth') body+=encoded+'; request sent Authorization: Bearer unregistered-malformed-auth'+slash+'n'+'public reason 0 and 1 '+slash;
        else body+=encoded+'; public reason 0 and 1 '+slash;
        res.writeHead(403);
        if(mode==='malformed-interrupted') {res.write(body);setTimeout(()=>res.destroy(),20);}
        else res.end(body);
        return;
      }
      if(mode==='success-interrupted') {res.writeHead(200);res.write(JSON.stringify({content:Buffer.from('successful-configuration-payload-canary').toString('base64')}).slice(0,-1));setTimeout(()=>res.destroy(),20);return;}
      if(mode==='expanded') {res.writeHead(403);res.end(JSON.stringify({message:'Request denied 100. '+'z '.repeat(180000)}));return;}
      if(mode.startsWith('preserve-')) {
        res.writeHead(404);
        if(mode==='preserve-large') res.end(JSON.stringify({detail:'x'.repeat(1100000),message:'Branch not protected'}));
        else {res.write('{"detail":"initial prefix",');setTimeout(()=>res.end('"message":"Branch not protected"}'),6100);}
        return;
      }
      if(mode.startsWith('credential-')) {
        const encoded=JSON.stringify(credential).slice(1,-1), opening='{"message":"Denied for issue 22; context 0 and 1. ';
        res.writeHead(403);
        if(mode==='credential-limit') res.end(opening+'x'.repeat(1024*1024-encoded.length+1-Buffer.byteLength(opening))+encoded+'"}');
        else {res.write(opening+encoded.slice(0,-1));if(mode==='credential-disconnect')setTimeout(()=>res.destroy(),20);else setTimeout(()=>res.end(encoded.slice(-1)+'"}'),6100);}
        return;
      }
      if(mode==='complete-prefix') {res.writeHead(403,{'content-type':'text/plain'});res.end('Denied for issue 22; context 0 and 1; ordinary a');return;}
      if(mode==='timeout' || mode==='interrupted') {res.writeHead(403);res.write('failure begins');if(mode==='interrupted')setTimeout(()=>res.destroy(),20);else setTimeout(()=>res.end(),6100);return;}
      if(mode==='enrollment' && req.method==='GET') {res.writeHead(404);res.end(JSON.stringify({message:'label missing'}));return;}
      if(mode==='success') {res.end(JSON.stringify({message:'success-private-body-canary'}));return;}
      if(mode==='headers') {res.writeHead(403,{'content-type':'text/plain'});res.end(headerMessage);return;}
      if(mode==='graphql') {res.end(JSON.stringify({data:null,errors:[{message:'GraphQL permission denied',extensions:{type:'FORBIDDEN'}}]}));return;}
      if(mode==='429') {res.setHeader('x-ratelimit-remaining','0');res.setHeader('retry-after','120');}
      res.writeHead(Number(mode)||403);
      const payload=JSON.stringify({message,['prefix-actual-credential-canary']:'key failure reason',authorization:'unregistered-auth-canary','x-api-key':'structured-x-api-key-canary','api-key':'structured-api-key-canary','set-cookie':['session=unregistered-cookie-canary',{nested:'nested-cookie-canary'}],after_auth:'provider context after authentication',trace:headerMessage,signedUrl:'https://storage.invalid/file?sig=signed-canary',detail:mode.startsWith('overflow')?'x'.repeat(1100000):'complete detail'});
      res.end(mode==='overflow-escaped'?payload.replaceAll('/',String.fromCharCode(92)+'u002f'):payload);
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base='http://127.0.0.1:'+server.address().port;
    const client=createGitHubClient('owner/repo',credential,diagnostics,base);
    let code,consumerMessagePreserved;
    try {
      if(mode==='enrollment') await new OctokitWriter('owner/repo',client).enrollManaged(22,new AbortController().signal);
      else await client.request(mode==='graphql'?'POST /graphql':'GET /repos/{owner}/{repo}',{owner:'owner',repo:'repo'});
    } catch(error) {code=error.code??error.status;if(mode.startsWith('preserve-'))consumerMessagePreserved=error.response?.data?.message==='Branch not protected';}
    finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    console.log(JSON.stringify({code,requests,consumerMessagePreserved,message:mode==='literal-escapes'?literalMessage:mode==='large'?message.replaceAll('actual-credential-canary','[redacted]'):undefined}));
  `,
      mode,
      credential,
    ],
    {
      cwd: new URL("../", import.meta.url),
      encoding: "utf8",
      timeout: 12000,
      maxBuffer: 12 * 1024 * 1024,
      env: {
        ...process.env,
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_RUN_ID: "100",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_SHA: "a".repeat(40),
      },
    },
  );
  expect(result.status, result.stderr.slice(-4000)).toBe(0);
  const lines = result.stderr
    .split("\n")
    .filter((line) => line.startsWith("{"));
  for (const line of lines)
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(2048);
  const logs = lines.map((line) => JSON.parse(line));
  return {
    logs,
    output: result.stderr,
    result: JSON.parse(result.stdout.trim()),
  };
}
function body(logs: Array<Record<string, unknown>>, requestId?: unknown) {
  return logs
    .filter(
      (row) =>
        row.event === "api.response.detail" &&
        row.detail_kind === "body" &&
        (!requestId || row.request_id === requestId),
    )
    .map((row) => row.content)
    .join("");
}

describe("actual API diagnostics in Actions stderr", () => {
  it("protects parser previews while preserving complete non-parser failure messages", () => {
    const credential = "parser-private-credential-canary";
    const lines: string[] = [];
    const diagnostics = createApiDiagnostics(
      createKnownSecretChecker([credential]),
      { repository: "owner/repo" },
      (line) => lines.push(line),
    );
    let parserError: unknown;
    try {
      JSON.parse(credential + "; public context 0 and 1");
    } catch (error) {
      parserError = error;
    }
    expect(parserError).toBeInstanceOf(SyntaxError);
    const message = `Provider failed request 100; ordinary "${credential.slice(0, 10)}"; values 0 and 1.`;
    diagnostics
      .start("model", "decode")
      .fail(new Error(message, { cause: parserError }), {
        status: 200,
        body:
          credential +
          "; Provider malformed JSON failure 100; public context 0 and 1.",
      });
    const logs = lines.map((line) => JSON.parse(line));
    const cause = JSON.parse(
      logs
        .filter((row) => row.detail_kind === "cause")
        .map((row) => row.content)
        .join(""),
    );
    expect(cause.message).toBe(message);
    expect(cause.cause.name).toBe("SyntaxError");
    expect(cause.cause.message).toContain("Unexpected token");
    expect(cause.cause.message).not.toContain(credential.slice(0, 10));
    expect(cause.cause.stack).not.toContain(credential.slice(0, 10));
    expect(lines.join("\n")).not.toContain(credential);
    expect(body(logs)).toContain(
      "Provider malformed JSON failure 100; public context 0 and 1.",
    );
  });
  it.each([401, 422, 429, 503])(
    "preserves status %s and provider evidence",
    (status) => {
      const r = run(String(status));
      expect(
        r.logs.find((row) => row.event === "api.request.failed"),
      ).toMatchObject({ status });
      expect(body(r.logs)).toContain("Denied for issue 22");
      if (status === 429) {
        const headers = JSON.parse(
          r.logs
            .filter((row) => row.detail_kind === "headers")
            .map((row) => row.content)
            .join(""),
        );
        expect(headers).toMatchObject({
          "retry-after": "120",
          "x-ratelimit-remaining": "0",
        });
      }
    },
  );
  it("keeps provider reasons and numeric correlation while excluding only credentials", () => {
    const r = run("failure");
    const failed = r.logs.find((row) => row.event === "api.request.failed");
    expect(failed).toMatchObject({
      status: 403,
      repository: "owner/repo",
      workflow_run_id: "100",
      run_attempt: "1",
      issue_number: 22,
    });
    expect(body(r.logs)).toContain(
      "Denied for issue 22 with status 403; request 100.",
    );
    expect(r.output).toContain("provider-request-100");
    expect(r.output).toContain("issues=write");
    expect(body(r.logs)).toContain("key failure reason");
    for (const credential of [
      "actual-credential-canary",
      "unregistered-auth-canary",
      "server-authorization-canary",
      "signed-canary",
      "unregistered-cookie-canary",
      "nested-cookie-canary",
      "structured-x-api-key-canary",
      "structured-api-key-canary",
    ])
      expect(r.output).not.toContain(credential);
  });
  it("retains label creation denial before the fallback not-found response", () => {
    const r = run("enrollment");
    expect(r.result.code).toBe("github_not_found");
    const failures = r.logs.filter((row) => row.event === "api.request.failed");
    expect(failures.map((row) => row.status)).toEqual([404, 403, 404]);
    expect(body(r.logs, failures[1].request_id)).toContain(
      "Denied for issue 22",
    );
  });
  it.each(
    ["headers", "overflow-escaped"].flatMap((mode) =>
      ["actual-credential-canary", "key"].map((credential) => ({
        mode,
        credential,
      })),
    ),
  )(
    "excludes unregistered plaintext authentication headers from $mode bodies with credential $credential",
    ({ mode, credential }) => {
      const r = run(mode, credential);
      expect(body(r.logs)).toContain(
        "Provider access denied with context 0 and 1",
      );
      expect(body(r.logs)).toContain("Provider reason ends");
      for (const credential of [
        "header-auth-canary",
        "header-proxy-canary",
        "header-cookie-canary",
        "header-set-cookie-canary",
        "unregistered-xapi-canary",
        "unregistered-api-canary",
        "url-api-canary",
        "inline-auth-canary",
      ])
        expect(r.output).not.toContain(credential);
    },
  );
  it("records GraphQL errors returned with HTTP 200", () => {
    const r = run("graphql");
    expect(
      r.logs.find((row) => row.event === "api.request.failed"),
    ).toMatchObject({ status: 200, route: "/graphql" });
    expect(body(r.logs)).toContain("GraphQL permission denied");
  });
  it("preserves literal escapes in ordinary failure bodies", () => {
    const r = run("literal-escapes");
    expect(body(r.logs)).toBe(r.result.message);
  });
  it.each(
    [
      "malformed-complete",
      "malformed-interrupted",
      "malformed-prefix",
      "malformed-internal",
      "malformed-auth",
    ].flatMap((mode) =>
      [
        "actual-credential-canary",
        'quoted-"credential\\suffix',
        "token-credential-é",
      ].map((credential) => ({ mode, credential })),
    ),
  )(
    "protects $mode quoted failures with credential $credential",
    ({ mode, credential }) => {
      const r = run(mode, credential);
      expect(
        r.logs.find((row) => row.event === "api.request.failed"),
      ).toMatchObject({ status: 403 });
      const captured = body(r.logs);
      expect(captured).toContain("Provider malformed denial 100");
      if (mode !== "malformed-prefix")
        expect(captured).toContain("public reason 0 and 1");
      expect(r.output).not.toContain(credential);
      const encoded = credential
        .split("")
        .map((char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"))
        .join("");
      expect(captured).not.toContain(encoded.slice(0, -6));
      expect(captured).not.toContain(credential.slice(0, -1));
      expect(r.output).not.toContain("unregistered-malformed-auth");
      if (mode === "malformed-internal")
        expect(captured).toContain("invalid escape");
      expect(
        r.logs.find((row) => row.detail_kind === "body").capture_state,
      ).toBe(mode === "malformed-interrupted" ? "read_failed" : "complete");
    },
  );
  it("logs success metadata without a response body", () => {
    const r = run("success");
    expect(
      r.logs.find((row) => row.event === "api.request.finished"),
    ).toMatchObject({ status: 200 });
    expect(r.output).not.toContain("success-private-body-canary");
    expect(body(r.logs)).toBe("");
  });
  it("excludes interrupted successful payloads while retaining transport evidence", () => {
    const r = run("success-interrupted");
    expect(body(r.logs)).toBe("");
    expect(r.output).not.toContain(
      Buffer.from("successful-configuration-payload-canary").toString("base64"),
    );
    expect(
      r.logs.find((row) => row.event === "api.request.failed"),
    ).toMatchObject({
      status: 200,
      capture_state: "read_failed",
      body_capture: "excluded_successful_response",
      captured_bytes: 0,
    });
    expect(r.logs.some((row) => row.detail_kind === "cause")).toBe(true);
  });
  it.each(["preserve-large", "preserve-slow"])(
    "preserves the actual Octokit error message for %s bodies",
    (mode) => {
      const r = run(mode);
      expect(r.result.code).toBe(404);
      expect(r.result.consumerMessagePreserved).toBe(true);
      expect(
        r.logs.some(
          (row) =>
            row.detail_kind === "body" &&
            row.capture_state ===
              (mode === "preserve-large" ? "byte_limit" : "read_timeout"),
        ),
      ).toBe(true);
    },
    15000,
  );
  it("reports byte limits introduced by credential-protection expansion", () => {
    const r = run("expanded", "z");
    const parts = r.logs.filter((row) => row.detail_kind === "body");
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0].capture_state).toBe("byte_limit");
    expect(parts[0].omitted_bytes).toBeGreaterThan(0);
    expect(Buffer.byteLength(body(r.logs))).toBeLessThanOrEqual(1024 * 1024);
  });
  it("reconstructs long Unicode failures from bounded numbered records", () => {
    const r = run("large");
    expect(JSON.parse(body(r.logs)).message).toBe(r.result.message);
    const parts = r.logs.filter(
      (row) =>
        row.event === "api.response.detail" && row.detail_kind === "body",
    );
    expect(parts.length).toBeGreaterThan(5);
    expect(parts.map((row) => row.part)).toEqual(parts.map((_, i) => i + 1));
    expect(parts.at(-1)!.last).toBe(true);
  });
  it("reports capture overflow explicitly", () => {
    const r = run("overflow");
    expect(
      r.logs.some(
        (row) =>
          row.detail_kind === "body" &&
          row.capture_state === "byte_limit" &&
          (row.omitted_bytes > 0 || row.omitted_bytes === -1),
      ),
    ).toBe(true);
  });
  it("protects escaped URLs in incomplete JSON without erasing the provider reason", () => {
    const r = run("overflow-escaped");
    expect(body(r.logs)).toContain("Denied for issue 22");
    expect(body(r.logs)).toContain("[signed URL excluded]");
    expect(r.output).not.toContain("signed-canary");
    expect(r.output).not.toContain("unregistered-auth-canary");
    expect(r.output).not.toContain("unregistered-cookie-canary");
    expect(r.output).not.toContain("nested-cookie-canary");
    expect(r.output).not.toContain("structured-x-api-key-canary");
    expect(r.output).not.toContain("structured-api-key-canary");
    expect(body(r.logs)).toContain("provider context after authentication");
    expect(r.logs.some((row) => row.capture_state === "byte_limit")).toBe(true);
  });
  it("retains partial GitHub bodies and original read failures", () => {
    const r = run("interrupted");
    expect(body(r.logs)).toBe("failure begins");
    expect(r.logs.some((row) => row.capture_state === "read_failed")).toBe(
      true,
    );
    const readCause = r.logs
      .filter((row) => row.detail_kind === "read_cause")
      .map((row) => row.content)
      .join("");
    expect(readCause).toMatch(/terminated|aborted|socket/i);
    expect(
      r.logs.find((row) => row.event === "api.request.failed").status,
    ).toBe(403);
  });
  it.each(
    ["credential-limit", "credential-disconnect", "credential-timeout"].flatMap(
      (mode) =>
        ["actual-credential-canary", 'quoted-"credential\\suffix'].map(
          (credential) => ({ mode, credential }),
        ),
    ),
  )(
    "excludes a credential prefix from $mode captures with $credential",
    ({ mode, credential }) => {
      const r = run(mode, credential);
      const content = body(r.logs);
      expect(content.includes("Denied for issue 22; context 0 and 1.")).toBe(
        true,
      );
      expect(content.includes(credential.slice(0, -1))).toBe(false);
      expect(
        content.includes(JSON.stringify(credential).slice(1, -1).slice(0, -1)),
      ).toBe(false);
      expect(
        r.logs.some(
          (row) =>
            row.detail_kind === "body" &&
            row.capture_state ===
              (mode === "credential-limit"
                ? "byte_limit"
                : mode === "credential-disconnect"
                  ? "read_failed"
                  : "read_timeout"),
        ),
      ).toBe(true);
    },
    15000,
  );
  it("preserves ordinary credential-prefix text in complete failure bodies", () => {
    const r = run("complete-prefix");
    expect(body(r.logs)).toBe(
      "Denied for issue 22; context 0 and 1; ordinary a",
    );
    expect(body(r.logs)).not.toContain("[credential prefix excluded]");
  });
  it("protects a root credential prefix when helper detail records are interrupted", () => {
    type DiagnosticRecord = {
      [key: string]: string | number | boolean | undefined;
    };
    const credential = "root-credential-" + "R".repeat(2048);
    const helperRecords: DiagnosticRecord[] = [],
      rootRecords: DiagnosticRecord[] = [];
    const helper = createApiDiagnostics(
      createKnownSecretChecker(["helper-token"]),
      {},
      (line) => helperRecords.push(JSON.parse(line)),
    );
    helper.start("artifact", "list").fail(new Error("Artifact denied."), {
      body: "Provider denied 0 and 1. " + credential + " trailing evidence",
    });
    const partial = helperRecords.find((row) => row.detail_kind === "body")!;
    expect(partial.last).toBe(false);
    expect(String(partial.content)).toContain(credential.slice(0, 40));
    const credentials = createKnownSecretChecker([credential]);
    const root = createApiDiagnostics(
      {
        ...credentials,
        redact: createKnownSecretChecker(["0", "1", "denied"]).redact,
        redactCredentials: credentials.redact,
      },
      {},
      (line) => {
        expect(Buffer.byteLength(line)).toBeLessThanOrEqual(2048);
        rootRecords.push(JSON.parse(line));
      },
    );
    root.forward(partial);
    root.flush();
    expect(body(rootRecords)).toContain("Provider denied 0 and 1.");
    expect(body(rootRecords)).toContain("[credential prefix excluded]");
    expect(body(rootRecords)).not.toContain(credential.slice(0, 40));
    expect(
      rootRecords.every((row) => row.capture_state === "interrupted"),
    ).toBe(true);
  });
  it("preserves transport causes", () => {
    const r = run("transport");
    expect(r.logs.some((row) => row.event === "api.request.failed")).toBe(true);
    expect(r.output).toMatch(/socket|fetch failed|other side closed/i);
  });
  it("bounds a stalled error-body read and identifies the capture timeout", () => {
    const r = run("timeout");
    expect(body(r.logs)).toBe("failure begins");
    expect(r.logs.some((row) => row.capture_state === "read_timeout")).toBe(
      true,
    );
  }, 15000);
});

describe("actual artifact SDK transport diagnostics", () => {
  it.each(["success", "interrupted"])(
    "preserves actual SDK streams and causes for %s blob bodies",
    (mode) => {
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
      import {createServer} from 'node:https';
      import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
      import {execFileSync} from 'node:child_process';
      import {join} from 'node:path';import {tmpdir} from 'node:os';
      import {createHash} from 'node:crypto';import * as tls from 'node:tls';
      import {artifactFixture} from './tests/integration/actions/artifact-fixture.mjs';
      import {createApiDiagnostics} from './src/logging/api.ts';
      import {createKnownSecretChecker} from './src/logging/redact.ts';
      import {observeArtifactHttp} from './src/adapters/github/artifact-http.ts';
      const mode=process.argv[1],root=await mkdtemp(join(tmpdir(),'orm-sdk-stream-'));
      execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(root,'key.pem'),'-out',join(root,'ca.pem'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1','-addext','basicConstraints=critical,CA:TRUE'],{stdio:'ignore'});
      const cert=await readFile(join(root,'ca.pem'));
      tls.setDefaultCACertificates([...tls.getCACertificates('default'),cert]);
      const token='header.'+Buffer.from(JSON.stringify({scp:'Actions.Results:one:two'})).toString('base64url')+'.signature';
      const config={github:{token:'sdk-github-canary'},proxy:{key:'sdk-proxy-canary'},session_key:'sdk-session-canary',artifact_tokens:{100:token},artifact_read_delay_ms:3};
      let fixture;
      const server=createServer({key:await readFile(join(root,'key.pem')),cert},async(req,res)=>{if(!await fixture.handle(req,res)){res.writeHead(404);res.end();}});
      await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
      config.artifact_origin='https://127.0.0.1:'+server.address().port;
      fixture=artifactFixture(config);
      process.env.ACTIONS_RUNTIME_TOKEN=token;process.env.ACTIONS_RESULTS_URL=config.artifact_origin;
      process.env.GITHUB_API_URL=config.artifact_origin;process.env.GITHUB_WORKSPACE=root;
      process.env.ACTIONS_ARTIFACT_UPLOAD_CONCURRENCY='1';process.env.NO_PROXY='127.0.0.1,localhost';process.env.no_proxy=process.env.NO_PROXY;
      const interrupted=Promise.withResolvers();
      const diagnostics=createApiDiagnostics(createKnownSecretChecker([token,config.github.token,config.proxy.key,config.session_key]),{repository:'owner/repo'},line=>{
        console.error(line);
        const record=JSON.parse(line);
        if(record.event==='api.request.failed' && record.route==='/artifact-blob' && record.status===200) interrupted.resolve();
      });
      const operation=diagnostics.start('artifact','stream');const restore=observeArtifactHttp(diagnostics,operation.id);
      let error,digestMismatch,downloadDigest,expected;
      try {
        const {DefaultArtifactClient}=await import('@actions/artifact');const client=new DefaultArtifactClient();
        const path=join(root,'fixture.orm');
        const payload=Buffer.concat([Buffer.from('ORMSESSION1\\nsuccessful-blob-payload-canary\\n'),Buffer.alloc(mode==='success'?8*1024*1024:65536,120)]);
        expected=createHash('sha256').update(payload).digest('hex');await writeFile(path,payload);
        const uploaded=await client.uploadArtifact('fixture.orm',[path],root,{skipArchive:true,retentionDays:14});
        if(mode==='interrupted') fixture.fault(uploaded.id,'drop_download');
        const download=client.downloadArtifact(uploaded.id,{path:join(root,'download'),skipDecompress:true,expectedHash:'sha256:'+expected,
          findBy:{token:config.github.token,repositoryOwner:'owner',repositoryName:'repo',workflowRunId:100}});
        if(mode==='interrupted') {
          download.catch(()=>{});
          await interrupted.promise;
          error='download interrupted';
        } else {
          const downloaded=await download;
          digestMismatch=downloaded.digestMismatch;
          downloadDigest=createHash('sha256').update(await readFile(join(root,'download','fixture.orm'))).digest('hex');
          operation.finish();
        }
      } catch(cause) {error=cause.message;operation.fail(cause);}
      finally {restore();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true});}
      process.stderr.write('',()=>process.stdout.write(JSON.stringify({error,digestMismatch,downloadDigest,expected,proof:fixture.proof()})+'\\n',()=>{
        if(mode==='interrupted') process.exit(0);
      }));
    `,
          mode,
        ],
        {
          cwd: new URL("../", import.meta.url),
          encoding: "utf8",
          timeout: 45000,
          maxBuffer: 8 * 1024 * 1024,
        },
      );
      expect(result.status, result.stderr.slice(-3000)).toBe(0);
      const summary = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
      const logs = result.stderr
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line));
      expect(summary.proof.errors).toEqual([]);
      expect(
        summary.proof.requests.some(
          (row: { read_delays: number }) => row.read_delays > 1,
        ),
      ).toBe(true);
      if (mode === "success") {
        expect(summary.error).toBeUndefined();
        expect(summary.digestMismatch).toBe(false);
        expect(summary.downloadDigest).toBe(summary.expected);
        expect(
          logs.filter((row) => row.event === "api.request.failed"),
        ).toEqual([]);
        const blocks = logs.filter(
          (row) => row.event === "api.request.started" && row.method === "PUT",
        );
        expect(blocks.length).toBeGreaterThan(1);
        expect(blocks.every((row) => row.attempt === 1)).toBe(true);
      } else {
        expect(summary.error).toBe("download interrupted");
        const failures = logs.filter(
          (row) => row.event === "api.request.failed" && row.status === 200,
        );
        expect(failures).toHaveLength(1);
        expect(body(logs)).toBe("");
        expect(result.stderr).not.toContain("successful-blob-payload-canary");
        expect(failures[0]).toMatchObject({
          body_capture: "excluded_successful_response",
          captured_bytes: 0,
        });
        for (const failed of failures) {
          const cause = logs
            .filter(
              (row) =>
                row.request_id === failed.request_id &&
                row.detail_kind === "cause",
            )
            .map((row) => row.content)
            .join("");
          expect(JSON.parse(cause)).toMatchObject({
            code: "ECONNRESET",
            message: "aborted",
          });
          expect(
            logs.some(
              (row) =>
                row.request_id === failed.request_id &&
                row.capture_state === "read_failed",
            ),
          ).toBe(true);
        }
        expect(
          summary.proof.requests.filter(
            (row: { interrupted: boolean }) => row.interrupted,
          ),
        ).toHaveLength(1);
      }
    },
    50000,
  );
  it.each([
    "list",
    "upload",
    "download",
    "retry",
    "application",
    "slow-success",
    "slow-application",
    "large-application",
    "credential-prefix",
  ])(
    "retains %s response details before SDK wrapping",
    (mode) => {
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
      import {createServer} from 'node:http';
      import {mkdtemp,writeFile,rm} from 'node:fs/promises';
      import {join} from 'node:path';
      import {tmpdir} from 'node:os';
      import {createApiDiagnostics} from './src/logging/api.ts';
      import {createKnownSecretChecker} from './src/logging/redact.ts';
      import {observeArtifactHttp} from './src/adapters/github/artifact-http.ts';
      const mode=process.argv[1],calls=[];
      const token='header.'+Buffer.from(JSON.stringify({scp:'Actions.Results:one:two'})).toString('base64url')+'.signature';
      const server=createServer((req,res)=>{
        req.resume();calls.push(req.url);
        res.setHeader('content-type','application/json');res.setHeader('x-request-id','artifact-provider-100');
        if(mode==='credential-prefix') {
          const opening='{"message":"Artifact credential-prefix denied for workflow 100 ';
          res.writeHead(403);res.end(opening+'x'.repeat(1024*1024-token.length+1-Buffer.byteLength(opening))+token+'"}');return;
        }
        if(mode==='slow-success') {
          res.write('{"artifacts":[],"detail":"successful-body-canary');
          setTimeout(()=>res.end('"}'),5500);return;
        }
        if(mode==='slow-application' || mode==='large-application') {
          const payload=JSON.stringify({ok:false,msg:'Artifact '+mode+' denied for workflow 100',token,authorization:'unknown-artifact-auth-canary',detail:mode==='large-application'?'x'.repeat(1100000):'complete reason'});
          if(mode==='slow-application') {res.write(payload.slice(0,-1));setTimeout(()=>res.end('}'),5500);}
          else res.end(payload);
          return;
        }
        if(mode==='retry' && calls.length>1) {res.end(JSON.stringify({artifacts:[]}));return;}
        if(mode==='download' && req.url.endsWith('ListArtifacts')) {
          res.end(JSON.stringify({artifacts:[{name:'fixture.orm',databaseId:'1',workflowRunBackendId:'one',workflowJobRunBackendId:'two'}]}));return;
        }
        res.statusCode=mode==='retry'?503:mode==='application'?200:403;
        res.end(JSON.stringify({ok:false,code:'permission_denied',msg:'Artifact '+mode+' denied for workflow 100',token,authorization:'unknown-artifact-auth-canary'}));
      });
      await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
      const root=await mkdtemp(join(tmpdir(),'orm-artifact-diagnostics-'));
      process.env.ACTIONS_RUNTIME_TOKEN=token;
      process.env.ACTIONS_RESULTS_URL='http://127.0.0.1:'+server.address().port;
      process.env.GITHUB_WORKSPACE=root;
      const diagnostics=createApiDiagnostics(createKnownSecretChecker([token]),{repository:'owner/repo',issue_number:22});
      const operation=diagnostics.start('artifact',mode);
      const restore=observeArtifactHttp(diagnostics,operation.id);
      let error;
      try {
        const {DefaultArtifactClient}=await import('@actions/artifact');
        const client=new DefaultArtifactClient();
        if(mode==='upload' || mode.endsWith('application')) {
          const path=join(root,'fixture.orm');await writeFile(path,'ORMSESSION1\\nfixture');
          await client.uploadArtifact('fixture.orm',[path],root,{skipArchive:true,retentionDays:14});
        } else if(mode==='download') await client.downloadArtifact(1,{path:root,skipDecompress:true});
        else await client.listArtifacts();
        operation.finish();
      } catch(cause) {error=cause.message;operation.fail(cause);}
      finally {restore();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true});}
      console.log(JSON.stringify({calls,error}));
    `,
          mode,
        ],
        {
          cwd: new URL("../", import.meta.url),
          encoding: "utf8",
          timeout: 26000,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      expect(result.status, result.stderr.slice(-3000)).toBe(0);
      const logs = result.stderr
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line));
      expect(result.stderr).toContain("artifact-provider-100");
      expect(result.stderr).not.toContain("unknown-artifact-auth-canary");
      const summary = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
      if (mode === "slow-success") {
        expect(summary.error).toBeUndefined();
        expect(
          logs.some(
            (row) => row.event === "api.request.finished" && row.status === 200,
          ),
        ).toBe(true);
        expect(
          logs.some(
            (row) =>
              row.event === "api.capture.incomplete" &&
              row.capture_state === "read_timeout",
          ),
        ).toBe(true);
        expect(
          logs.filter((row) => row.event === "api.request.failed"),
        ).toEqual([]);
        expect(body(logs)).toBe("");
        expect(result.stderr).not.toContain("successful-body-canary");
        return;
      }
      expect(body(logs)).toContain(
        "Artifact " + mode + " denied for workflow 100",
      );
      if (mode === "credential-prefix") {
        const token =
          "header." +
          Buffer.from(
            JSON.stringify({ scp: "Actions.Results:one:two" }),
          ).toString("base64url") +
          ".signature";
        expect(result.stderr).not.toContain(token.slice(0, -1));
        expect(body(logs)).toContain("[credential prefix excluded]");
        expect(logs.some((row) => row.capture_state === "byte_limit")).toBe(
          true,
        );
      }
      expect(
        logs.filter((row) => row.event === "api.request.failed" && row.status),
      ).toHaveLength(1);
      if (mode === "retry") {
        expect(summary.calls).toHaveLength(2);
        expect(summary.error).toBeUndefined();
        expect(
          logs.some(
            (row) => row.event === "api.request.finished" && row.attempt === 2,
          ),
        ).toBe(true);
      } else if (mode.endsWith("application")) {
        expect(summary.error).toBeTruthy();
        expect(
          logs.some(
            (row) => row.event === "api.request.failed" && row.status === 200,
          ),
        ).toBe(true);
        if (mode !== "application")
          expect(
            logs.some(
              (row) =>
                row.detail_kind === "body" &&
                row.capture_state ===
                  (mode === "slow-application" ? "read_timeout" : "byte_limit"),
            ),
          ).toBe(true);
      } else expect(summary.error).toContain("403");
    },
    30000,
  );
});
