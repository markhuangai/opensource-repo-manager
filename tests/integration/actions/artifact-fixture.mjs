import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export function artifactFixture(config) {
  const artifacts = [],
    requests = [],
    errors = [];
  let next = 4000,
    dropFinalize = false;
  const head = "f".repeat(40);
  const run = (id) => ({
    id,
    run_attempt: 1,
    head_sha: head,
    repository: { id: 42, full_name: "owner/repo" },
    head_repository: { id: 42 },
  });
  const metadata = (artifact) => ({
    id: artifact.id,
    name: artifact.name,
    size_in_bytes: artifact.bytes.length,
    digest: artifact.digest,
    expired: artifact.expired ?? false,
    expires_at: artifact.expires_at,
    created_at: artifact.created_at,
    workflow_run: {
      id: artifact.run,
      repository_id: artifact.foreign ? 999 : 42,
      head_repository_id: 42,
      head_sha: head,
    },
  });
  async function handle(req, res) {
    const url = new URL(req.url, "https://api.github.com");
    if (
      !url.pathname.startsWith("/twirp/") &&
      !url.pathname.startsWith("/_artifacts/") &&
      !url.pathname.startsWith("/repos/owner/repo/actions/")
    )
      return false;
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      requests.push({ method: req.method, path: url.pathname });
      res.setHeader("content-type", "application/json");
      if (url.pathname.startsWith("/twirp/")) {
        const current = Object.entries(config.artifact_tokens).find(
          ([, token]) => req.headers.authorization === `Bearer ${token}`,
        );
        assert(current, "Unknown artifact runtime credential");
        const runId = Number(current[0]),
          body = JSON.parse(bytes),
          method = url.pathname.split("/").at(-1);
        if (method === "ListArtifacts") {
          res.end(
            JSON.stringify({
              artifacts: artifacts
                .filter(
                  (item) =>
                    item.run === runId && item.finalized && !item.deleted,
                )
                .map((item) => ({
                  name: item.name,
                  databaseId: String(item.id),
                  size: String(item.bytes.length),
                  createdAt: item.created_at,
                  digest: item.digest,
                })),
            }),
          );
        } else if (method === "CreateArtifact") {
          assert.equal(body.version, 7);
          assert(
            body.name.endsWith(".orm"),
            "Uploaded a non-encrypted artifact",
          );
          const expires = body.expiresAt ?? body.expires_at;
          assert(
            Date.parse(expires) > Date.now() + 13.9 * 86400000,
            "Retention was not 14 days",
          );
          assert(
            !artifacts.some(
              (item) => item.run === runId && item.name === body.name,
            ),
            "Duplicate artifact creation",
          );
          const item = {
            id: next++,
            run: runId,
            name: body.name,
            expires_at: expires,
            created_at: new Date().toISOString(),
            bytes: Buffer.alloc(0),
            blocks: new Map(),
            finalized: false,
          };
          artifacts.push(item);
          res.end(
            JSON.stringify({
              ok: true,
              signedUploadUrl: `https://api.github.com/_artifacts/${item.id}?sig=fixture-only`,
            }),
          );
        } else if (method === "FinalizeArtifact") {
          const item = artifacts.find(
            (item) => item.run === runId && item.name === body.name,
          );
          assert(item);
          assert.equal(Number(body.size), item.bytes.length);
          const hash = body.hash?.value ?? body.hash;
          assert.equal(
            hash,
            `sha256:${createHash("sha256").update(item.bytes).digest("hex")}`,
          );
          assert(
            item.bytes.subarray(0, 12).equals(Buffer.from("ORMSESSION1\n")),
          );
          for (const secret of [
            config.github.token,
            config.proxy.key,
            config.session_key,
            ...Object.values(config.artifact_tokens),
          ])
            assert(
              !item.bytes.includes(Buffer.from(secret)),
              "Uploaded raw credential",
            );
          for (const marker of [
            "native-history-canary",
            "OPERATOR_SYSTEM_CANARY",
            "unfinished.txt",
          ])
            assert(
              !item.bytes.includes(Buffer.from(marker)),
              "Uploaded raw session data",
            );
          item.finalized = true;
          item.digest = hash;
          if (dropFinalize) {
            dropFinalize = false;
            req.socket.destroy();
          } else
            res.end(JSON.stringify({ ok: true, artifactId: String(item.id) }));
        } else throw new Error(`Unexpected artifact RPC ${method}`);
      } else if (url.pathname.startsWith("/_artifacts/")) {
        const item = artifacts.find(
          (item) => item.id === Number(url.pathname.split("/").at(-1)),
        );
        assert(item);
        if (req.method === "PUT" && url.searchParams.get("comp") === "block") {
          item.blocks.set(url.searchParams.get("blockid"), bytes);
          res.writeHead(201);
          res.end();
        } else if (
          req.method === "PUT" &&
          url.searchParams.get("comp") === "blocklist"
        ) {
          const ids = [
            ...bytes
              .toString()
              .matchAll(
                /<(?:Latest|Uncommitted)>([^<]+)<\/(?:Latest|Uncommitted)>/g,
              ),
          ].map((match) => match[1]);
          assert(ids.length);
          item.bytes = Buffer.concat(
            ids.map((id) => {
              assert(item.blocks.has(id));
              return item.blocks.get(id);
            }),
          );
          res.writeHead(201, {
            etag: '"fixture-etag"',
            "last-modified": new Date().toUTCString(),
          });
          res.end();
        } else if (req.method === "GET") {
          const data = Buffer.from(item.bytes);
          if (item.corrupt) data[data.length - 20] ^= 1;
          res.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-disposition": `attachment; filename="${item.name}"`,
            "content-length": data.length,
          });
          res.end(data);
        } else throw new Error("Unexpected artifact blob request");
      } else {
        assert.equal(req.headers.authorization, `token ${config.github.token}`);
        const attempt = /\/runs\/(\d+)\/attempts\/1$/.exec(url.pathname);
        const listing = /\/runs\/(\d+)\/artifacts$/.exec(url.pathname);
        const download = /\/artifacts\/(\d+)\/zip$/.exec(url.pathname);
        if (attempt) res.end(JSON.stringify(run(Number(attempt[1]))));
        else if (listing) {
          const name = url.searchParams.get("name");
          assert(/^orm-session-[a-f0-9-]{36}\.orm$/.test(name ?? ""));
          const selected = artifacts.filter(
            (item) =>
              item.run === Number(listing[1]) &&
              item.name === name &&
              item.finalized &&
              !item.deleted,
          );
          const page = Number(url.searchParams.get("page") ?? 1),
            count = Number(url.searchParams.get("per_page") ?? 100);
          res.end(
            JSON.stringify({
              total_count: selected.length,
              artifacts: selected
                .slice((page - 1) * count, page * count)
                .map(metadata),
            }),
          );
        } else if (download) {
          const item = artifacts.find(
            (item) => item.id === Number(download[1]),
          );
          assert(item?.finalized && !item.deleted);
          res.writeHead(302, {
            location: `https://api.github.com/_artifacts/${item.id}?sig=fixture-only`,
          });
          res.end();
        } else throw new Error("Unexpected artifact REST request");
      }
    } catch (error) {
      errors.push(error.message);
      res.writeHead(500);
      res.end(JSON.stringify({ message: "fixture failed" }));
    }
    return true;
  }
  return {
    handle,
    fault(id, kind) {
      if (kind === "drop_finalize") {
        dropFinalize = true;
        return;
      }
      const artifact = artifacts.find((item) => item.id === id);
      assert(artifact);
      for (const name of ["expired", "deleted", "corrupt", "foreign"])
        artifact[name] = kind === name;
    },
    proof: () => ({
      artifacts: artifacts.filter((item) => item.finalized).map(metadata),
      requests,
      errors,
    }),
  };
}
