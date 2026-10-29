import { randomBytes, randomUUID, createCipheriv, hkdfSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createServer } from "node:http";
import { Octokit } from "@octokit/rest";
import { afterEach, describe, expect, it } from "vitest";
import { captureActionsContext } from "../src/actions/context.ts";
import { GitHubArtifacts } from "../src/adapters/github/artifacts.ts";
import { separateSecrets } from "../src/config/secrets.ts";
import { fixtureConfiguration } from "./fixtures.ts";
import {
  fileDigest,
  openBundle,
  runtimeDigest,
  sealBundle,
  type BundleIdentity,
} from "../src/actions/bundle.ts";
import { digest } from "../src/domain/agents.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true });
});
const signal = () => new AbortController().signal;

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "orm-encrypted-session-"));
  roots.push(root);
  const identity: BundleIdentity = {
    version: 1,
    repository_id: 42,
    issue_id: 1001,
    task_id: randomUUID(),
    checkpoint_id: randomUUID(),
    generation: 2,
    state_digest: digest({ checkpoint: true }),
    snapshot_digest: "a".repeat(64),
    runtime_digest: runtimeDigest(),
    run_id: 100,
    run_attempt: 1,
  };
  const key = randomBytes(32).toString("base64"),
    path = join(root, "session.orm"),
    source = join(root, "database.sqlite");
  await writeFile(source, "private native history and unfinished workspace", {
    mode: 0o600,
  });
  const options = {
    identity,
    files: [{ name: "database.sqlite", path: source }],
    destination: path,
    secret: key,
    limit: 100000,
    signal: signal(),
  };
  const directory = async () => {
    const path = join(root, randomUUID());
    await mkdir(path, { mode: 0o700 });
    return path;
  };
  const reference = async () => ({
    ...identity,
    ...(await fileDigest(path, 100000, signal())),
    artifact_id: 200,
    expires_at: Date.now() + 86400000,
  });
  return { root, identity, key, path, source, options, directory, reference };
}

describe("encrypted Actions bundles", () => {
  it("compresses and authenticates an opaque bundle and restores exact bytes", async () => {
    const f = await setup();
    await sealBundle(f.options);
    const encrypted = await readFile(f.path);
    expect(encrypted.includes(Buffer.from("private native history"))).toBe(
      false,
    );
    const files = await openBundle({
      path: f.path,
      reference: await f.reference(),
      directory: await f.directory(),
      secret: f.key,
      limit: 100000,
      signal: signal(),
    });
    expect(await readFile(files.get("database.sqlite")!, "utf8")).toBe(
      await readFile(f.source, "utf8"),
    );
    const second = join(f.root, "second.orm");
    await sealBundle({ ...f.options, destination: second });
    expect(await readFile(second)).not.toEqual(encrypted);
  });

  it("restores many entries without retaining file-handle listeners", async () => {
    const f = await setup(),
      warnings: Error[] = [],
      observe = (warning: Error) => warnings.push(warning);
    process.on("warning", observe);
    try {
      const inputs = [
        ...f.options.files,
        ...Array.from({ length: 24 }, () => ({
          name: `sessions/${randomUUID()}.json`,
          path: f.source,
        })),
      ];
      await sealBundle({ ...f.options, files: inputs });
      const files = await openBundle({
        path: f.path,
        reference: await f.reference(),
        directory: await f.directory(),
        secret: f.key,
        limit: 100000,
        signal: signal(),
      });
      expect(files.size).toBe(inputs.length);
      for (const entry of inputs)
        expect(await readFile(files.get(entry.name)!)).toEqual(
          await readFile(entry.path),
        );
      expect(warnings).toEqual([]);
    } finally {
      process.removeListener("warning", observe);
    }
  });

  it("rejects corruption, wrong keys, foreign identity and incompatible runtimes before import", async () => {
    const f = await setup();
    await sealBundle(f.options);
    const reference = await f.reference();
    const attempt = async (changes: Record<string, unknown> = {}) =>
      openBundle({
        path: f.path,
        reference,
        directory: await f.directory(),
        secret: f.key,
        limit: 100000,
        signal: signal(),
        ...changes,
      });
    await expect(
      attempt({ secret: randomBytes(32).toString("base64") }),
    ).rejects.toThrow("session_corrupt");
    await expect(
      attempt({ reference: { ...reference, task_id: randomUUID() } }),
    ).rejects.toThrow("session_incompatible");
    const bytes = await readFile(f.path);
    bytes[bytes.length - 20] ^= 1;
    await writeFile(f.path, bytes);
    await expect(attempt()).rejects.toThrow("session_corrupt");
    await expect(attempt({ reference: await f.reference() })).rejects.toThrow(
      "session_corrupt",
    );
    const incompatible = join(f.root, "incompatible.orm");
    await sealBundle({
      ...f.options,
      identity: { ...f.identity, runtime_digest: "b".repeat(64) },
      destination: incompatible,
    });
    await expect(
      attempt({
        path: incompatible,
        reference: {
          ...reference,
          runtime_digest: "b".repeat(64),
          ...(await fileDigest(incompatible, 100000, signal())),
        },
      }),
    ).rejects.toThrow("session_incompatible");
  });

  it("bounds export and refuses forbidden bundle paths", async () => {
    const f = await setup();
    await expect(sealBundle({ ...f.options, limit: 10 })).rejects.toThrow();
    await expect(
      sealBundle({
        ...f.options,
        files: [{ name: "../../credentials", path: f.source }],
      }),
    ).rejects.toThrow();
    await expect(
      sealBundle({
        ...f.options,
        files: [f.options.files[0], f.options.files[0]],
      }),
    ).rejects.toThrow("session_file_invalid");
  });

  it("rejects authenticated unknown manifests, escaping paths and decompression bombs", async () => {
    const f = await setup();
    for (const manifest of [
      { version: 2, entries: [] },
      {
        version: 1,
        entries: [{ name: "../escape", size: 0, digest: "c".repeat(64) }],
      },
    ]) {
      const header = Buffer.from(JSON.stringify(f.identity)),
        length = Buffer.alloc(4);
      length.writeUInt32BE(header.length);
      const nonce = randomBytes(12),
        aad = Buffer.concat([
          Buffer.from("ORMSESSION1\n"),
          length,
          header,
          nonce,
        ]);
      const key = Buffer.from(
        hkdfSync(
          "sha256",
          Buffer.from(f.key, "base64"),
          "orm/actions/v1",
          "session-artifact-encryption/v1",
          32,
        ),
      );
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(aad);
      const data = Buffer.from(JSON.stringify(manifest)),
        prefix = Buffer.alloc(4);
      prefix.writeUInt32BE(data.length);
      const encrypted = Buffer.concat([
        aad,
        cipher.update(gzipSync(Buffer.concat([prefix, data]))),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      await writeFile(f.path, encrypted, { mode: 0o600 });
      await expect(
        openBundle({
          path: f.path,
          reference: await f.reference(),
          directory: await f.directory(),
          secret: f.key,
          limit: 100000,
          signal: signal(),
        }),
      ).rejects.toThrow("session_schema_unsupported");
    }
    const large = join(f.root, "large.sqlite");
    await writeFile(large, Buffer.alloc(200000), { mode: 0o600 });
    const bomb = join(f.root, "bomb.orm");
    await sealBundle({
      ...f.options,
      files: [{ name: "database.sqlite", path: large }],
      destination: bomb,
      limit: 300000,
    });
    await expect(
      openBundle({
        path: bomb,
        reference: {
          ...(await f.reference()),
          ...(await fileDigest(bomb, 100000, signal())),
        },
        directory: await f.directory(),
        secret: f.key,
        limit: 100000,
        signal: signal(),
      }),
    ).rejects.toThrow("session_size_limit");
  });
});

describe("checkpoint artifact selection", () => {
  it.each(["nullable digest", "more than 1000 artifacts"])(
    "ignores unrelated run artifacts with %s while preserving selected-artifact checks",
    async (mode) => {
      const f = await setup(),
        name = `orm-session-${f.identity.checkpoint_id}.orm`,
        path = join(f.root, name);
      await sealBundle({ ...f.options, destination: path });
      const observed = await fileDigest(path, f.options.limit, signal()),
        expires = new Date(Date.now() + 86400000).toISOString(),
        run = {
          id: 100,
          run_attempt: 1,
          head_sha: "f".repeat(40),
          repository: { id: 42, full_name: "owner/repo" },
          head_repository: { id: 42 },
        },
        selected = {
          id: 200,
          name,
          size_in_bytes: observed.size,
          digest: `sha256:${observed.digest}`,
          expired: false,
          expires_at: expires,
          workflow_run: {
            id: run.id,
            repository_id: 42,
            head_repository_id: 42,
            head_sha: run.head_sha,
          },
        },
        unrelated = Array.from(
          { length: mode === "nullable digest" ? 1 : 1001 },
          (_, index) => ({
            ...selected,
            id: index + 1000,
            name: `unrelated-${index}`,
            digest: mode === "nullable digest" ? null : selected.digest,
          }),
        ),
        queries: Array<string | null> = [];
      const server = createServer((request, response) => {
        const url = new URL(request.url!, "http://fixture");
        response.setHeader("content-type", "application/json");
        if (url.pathname.endsWith("/attempts/1"))
          return response.end(JSON.stringify(run));
        if (url.pathname.endsWith("/artifacts")) {
          const filter = url.searchParams.get("name"),
            rows = [selected, ...unrelated].filter(
              (artifact) => filter === null || artifact.name === filter,
            ),
            page = Number(url.searchParams.get("page") ?? 1),
            count = Number(url.searchParams.get("per_page") ?? 100);
          queries.push(filter);
          return response.end(
            JSON.stringify({
              total_count: rows.length,
              artifacts: rows.slice((page - 1) * count, page * count),
            }),
          );
        }
        response.writeHead(404).end("{}");
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("address");
        const { secrets } = separateSecrets(fixtureConfiguration()),
          transport = new GitHubArtifacts(
            {
              repository: "owner/repo",
              repository_id: 42,
              run_id: 100,
              run_attempt: 1,
              head_sha: run.head_sha,
              results_url: "https://results.actions.githubusercontent.com",
            },
            secrets,
            new Octokit({ baseUrl: `http://127.0.0.1:${address.port}` }),
          ),
          reference = await transport.upload(
            path,
            f.identity,
            f.options.limit,
            signal(),
          );
        expect(reference).toEqual({
          ...f.identity,
          ...observed,
          artifact_id: selected.id,
          expires_at: Date.parse(expires),
        });
        selected.expired = true;
        await expect(
          transport.download(
            reference,
            await f.directory(),
            f.options.limit,
            signal(),
          ),
        ).resolves.toBeUndefined();
        selected.digest = `sha256:${"0".repeat(64)}`;
        await expect(
          transport.download(
            reference,
            await f.directory(),
            f.options.limit,
            signal(),
          ),
        ).rejects.toThrow("session_provenance_invalid");
        expect(queries).toEqual([name, name, name]);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});

describe("protected Actions runtime context", () => {
  const environment = () => ({
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "owner/repo",
    GITHUB_REPOSITORY_ID: "42",
    GITHUB_RUN_ID: "100",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SHA: "a".repeat(40),
    ACTIONS_RUNTIME_TOKEN: "protected-runtime-token",
    ACTIONS_RESULTS_URL:
      "https://results-receiver.actions.githubusercontent.com/",
  });
  it("captures credentials outside the inherited environment", () => {
    const env = environment(),
      loaded = captureActionsContext(env);
    expect(loaded.context).toMatchObject({
      repository_id: 42,
      run_id: 100,
      run_attempt: 1,
    });
    expect(loaded.token).toBe("protected-runtime-token");
    expect(env).not.toHaveProperty("ACTIONS_RUNTIME_TOKEN");
    expect(env).not.toHaveProperty("ACTIONS_RESULTS_URL");
  });
  it("requires Actions identity and a credential-free trusted HTTPS results endpoint", () => {
    for (const changes of [
      { GITHUB_ACTIONS: "false" },
      { GITHUB_RUN_ID: "0" },
      { GITHUB_RUN_ATTEMPT: "NaN" },
      { ACTIONS_RUNTIME_TOKEN: "" },
      {
        ACTIONS_RESULTS_URL:
          "http://results-receiver.actions.githubusercontent.com/",
      },
      { ACTIONS_RESULTS_URL: "https://attacker.invalid/" },
      {
        ACTIONS_RESULTS_URL:
          "https://secret@results-receiver.actions.githubusercontent.com/",
      },
      {
        ACTIONS_RESULTS_URL:
          "https://results-receiver.actions.githubusercontent.com/?token=secret",
      },
    ])
      expect(() =>
        captureActionsContext({ ...environment(), ...changes }),
      ).toThrow("actions_context_invalid");
  });
});
