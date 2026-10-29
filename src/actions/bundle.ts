import { constants, createReadStream, createWriteStream } from "node:fs";
import { open, unlink } from "node:fs/promises";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { join } from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip } from "node:zlib";
import { z } from "zod";
import { digest, sdkVersions } from "../domain/agents.ts";
import { StateError } from "../domain/durability.ts";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().int().positive().safe();
export const bundleIdentitySchema = z.strictObject({
  version: z.literal(1),
  repository_id: positive,
  issue_id: positive,
  task_id: z.uuid(),
  checkpoint_id: z.uuid(),
  generation: z.number().int().nonnegative().safe(),
  state_digest: hash,
  snapshot_digest: hash,
  runtime_digest: hash,
  run_id: positive,
  run_attempt: positive,
});
export type BundleIdentity = z.infer<typeof bundleIdentitySchema>;
export const artifactReferenceSchema = bundleIdentitySchema.extend({
  artifact_id: positive,
  digest: hash,
  size: positive,
  expires_at: positive,
});
export type ArtifactReference = z.infer<typeof artifactReferenceSchema>;
const entrySchema = z.strictObject({
  name: z
    .string()
    .regex(
      /^(?:database\.sqlite|sessions\/[a-f0-9-]{36}\.json|blobs\/[a-f0-9]{64})$/,
    ),
  size: z.number().int().nonnegative().safe(),
  digest: hash,
});
const manifestSchema = z.strictObject({
  version: z.literal(1),
  entries: z.array(entrySchema).min(1).max(100000),
});
type Entry = z.infer<typeof entrySchema>;
const magic = Buffer.from("ORMSESSION1\n");
const metadataLimit = 16 * 1024 * 1024;

export function runtimeDigest() {
  return digest({
    format: 1,
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    sdks: sdkVersions,
  });
}

function key(secret: string) {
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(secret, "base64"),
      "orm/actions/v1",
      "session-artifact-encryption/v1",
      32,
    ),
  );
}

function bounded(limit: number, inspect?: (chunk: Buffer) => void) {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      if (bytes > limit) return done(new StateError("session_size_limit"));
      try {
        inspect?.(chunk);
        done(null, chunk);
      } catch (error) {
        done(error as Error);
      }
    },
  });
}

export async function fileDigest(
  path: string,
  limit: number,
  signal: AbortSignal,
) {
  const hash = createHash("sha256");
  let bytes = 0;
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid!() ||
      info.mode & 0o077 ||
      info.size > limit
    )
      throw new StateError("session_file_invalid");
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      signal.throwIfAborted();
      bytes += (chunk as Buffer).length;
      if (bytes > limit) throw new StateError("session_size_limit");
      hash.update(chunk as Buffer);
    }
    if (bytes !== info.size) throw new StateError("session_file_invalid");
    return { digest: hash.digest("hex"), size: bytes };
  } finally {
    await file.close();
  }
}

function length(value: number) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

export async function sealBundle(options: {
  identity: BundleIdentity;
  files: Array<{ name: string; path: string }>;
  destination: string;
  secret: string;
  limit: number;
  signal: AbortSignal;
}) {
  const { identity, files, destination, secret, limit, signal } = options;
  bundleIdentitySchema.parse(identity);
  const entries: Entry[] = [];
  let total = 0;
  for (const file of files) {
    const observed = await fileDigest(file.path, limit - total, signal);
    total += observed.size;
    entries.push(entrySchema.parse({ name: file.name, ...observed }));
  }
  if (new Set(entries.map((entry) => entry.name)).size !== entries.length)
    throw new StateError("session_file_invalid");
  const manifest = Buffer.from(
    JSON.stringify(manifestSchema.parse({ version: 1, entries })),
  );
  if (manifest.length > metadataLimit || total + manifest.length + 4 > limit)
    throw new StateError("session_size_limit");
  const header = Buffer.from(JSON.stringify(identity));
  const nonce = randomBytes(12);
  const aad = Buffer.concat([magic, length(header.length), header, nonce]);
  const cipher = createCipheriv("aes-256-gcm", key(secret), nonce);
  cipher.setAAD(aad);
  const output = await open(destination, "wx", 0o600);
  try {
    await output.writeFile(aad);
    async function* content() {
      yield length(manifest.length);
      yield manifest;
      for (const [index, file] of files.entries()) {
        const observed = createHash("sha256");
        let bytes = 0;
        const source = await open(
          file.path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const info = await source.stat();
          if (
            !info.isFile() ||
            info.nlink !== 1 ||
            info.uid !== process.getuid!() ||
            info.mode & 0o077
          )
            throw new StateError("session_file_invalid");
          for await (const chunk of source.createReadStream({
            autoClose: false,
          })) {
            signal.throwIfAborted();
            const data = chunk as Buffer;
            bytes += data.length;
            if (bytes > entries[index].size)
              throw new StateError("session_file_invalid");
            observed.update(data);
            yield data;
          }
        } finally {
          await source.close();
        }
        if (
          bytes !== entries[index].size ||
          observed.digest("hex") !== entries[index].digest
        )
          throw new StateError("session_file_invalid");
      }
    }
    await pipeline(
      Readable.from(content()),
      bounded(limit),
      createGzip(),
      cipher,
      bounded(limit - aad.length - 16),
      new Writable({
        write(chunk: Buffer, _encoding, done) {
          void output.writeFile(chunk).then(() => done(), done);
        },
      }),
      { signal },
    );
    await output.writeFile(cipher.getAuthTag());
    await output.sync();
  } finally {
    await output.close();
  }
  return fileDigest(destination, limit, signal);
}

async function readExact(
  file: Awaited<ReturnType<typeof open>>,
  bytes: number,
  position: number,
) {
  const buffer = Buffer.alloc(bytes);
  let read = 0;
  while (read < bytes) {
    const next = await file.read(buffer, read, bytes - read, position + read);
    if (!next.bytesRead) throw new StateError("session_corrupt");
    read += next.bytesRead;
  }
  return buffer;
}

export async function openBundle(options: {
  path: string;
  reference: ArtifactReference;
  directory: string;
  secret: string;
  limit: number;
  signal: AbortSignal;
}): Promise<Map<string, string>> {
  const { path, reference, directory, secret, limit, signal } = options;
  const observed = await fileDigest(path, limit, signal);
  if (observed.digest !== reference.digest || observed.size !== reference.size)
    throw new StateError("session_corrupt");
  const compressed = join(directory, "authenticated.gz");
  const plaintext = join(directory, "bundle.payload");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const prefix = await readExact(file, magic.length + 4, 0);
    const bytes = prefix.readUInt32BE(magic.length);
    if (!prefix.subarray(0, magic.length).equals(magic) || bytes > 4096)
      throw new StateError("session_schema_unsupported");
    const header = await readExact(file, bytes + 12, prefix.length);
    let identity: BundleIdentity;
    try {
      identity = bundleIdentitySchema.parse(
        JSON.parse(header.subarray(0, bytes).toString("utf8")),
      );
    } catch {
      throw new StateError("session_schema_unsupported");
    }
    if (
      Object.entries(identity).some(
        ([name, value]) => reference[name as keyof ArtifactReference] !== value,
      ) ||
      identity.runtime_digest !== runtimeDigest()
    )
      throw new StateError("session_incompatible");
    const aad = Buffer.concat([prefix, header]);
    if (observed.size <= aad.length + 16)
      throw new StateError("session_corrupt");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key(secret),
      header.subarray(bytes),
    );
    decipher.setAAD(aad);
    decipher.setAuthTag(await readExact(file, 16, observed.size - 16));
    try {
      await pipeline(
        file.createReadStream({
          start: aad.length,
          end: observed.size - 17,
          autoClose: false,
        }),
        decipher,
        bounded(limit),
        createWriteStream(compressed, { flags: "wx", mode: 0o600 }),
        { signal },
      );
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof StateError) throw error;
      throw new StateError("session_corrupt");
    }
    await pipeline(
      createReadStream(compressed),
      createGunzip(),
      bounded(limit),
      createWriteStream(plaintext, { flags: "wx", mode: 0o600 }),
      { signal },
    );
    const payload = await open(
      plaintext,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const size = (await payload.stat()).size;
      const count = (await readExact(payload, 4, 0)).readUInt32BE();
      if (count > metadataLimit || count + 4 > size)
        throw new StateError("session_size_limit");
      let manifest: z.infer<typeof manifestSchema>;
      try {
        manifest = manifestSchema.parse(
          JSON.parse((await readExact(payload, count, 4)).toString("utf8")),
        );
      } catch {
        throw new StateError("session_schema_unsupported");
      }
      let position = 4 + count;
      const result = new Map<string, string>();
      for (const [index, entry] of manifest.entries.entries()) {
        signal.throwIfAborted();
        if (result.has(entry.name) || position + entry.size > size)
          throw new StateError("session_corrupt");
        const target = join(directory, `entry-${index}`);
        const hash = createHash("sha256");
        if (entry.size) {
          const input = await open(
            plaintext,
            constants.O_RDONLY | constants.O_NOFOLLOW,
          );
          try {
            await pipeline(
              input.createReadStream({
                start: position,
                end: position + entry.size - 1,
              }),
              bounded(entry.size, (chunk) => {
                hash.update(chunk);
              }),
              createWriteStream(target, { flags: "wx", mode: 0o600 }),
              { signal },
            );
          } finally {
            await input.close();
          }
        } else {
          const empty = await open(target, "wx", 0o600);
          await empty.close();
        }
        if (hash.digest("hex") !== entry.digest)
          throw new StateError("session_corrupt");
        position += entry.size;
        result.set(entry.name, target);
      }
      if (position !== size || !result.has("database.sqlite"))
        throw new StateError("session_corrupt");
      return result;
    } finally {
      await payload.close();
    }
  } finally {
    await file.close();
    for (const temporary of [compressed, plaintext])
      await unlink(temporary).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
  }
}
