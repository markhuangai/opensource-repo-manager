import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SecretAccessor } from "../../config/secrets.ts";
import { digest, RuntimeError } from "../../domain/agents.ts";
import { rootDirectory } from "../workspaces/files.ts";
import { trustedExecutable } from "../../runtime/process.ts";
import {
  isAlias,
  isCollection,
  isPair,
  isScalar,
  parseAllDocuments,
  parseDocument,
} from "yaml";

export const scannerPolicy = Object.freeze({
  version: "gitleaks-8.30.1-publication-v1",
  config: "[extend]\nuseDefault = true\n",
  inline_suppression: false,
  binary_changes: false,
});
export const policyIdentity = digest(scannerPolicy);

export function publicationText(bytes: Uint8Array, path = "") {
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new RuntimeError("publication_binary_unsupported");
  }
  if (
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
    }) ||
    /\.(?:zip|gz|tgz|tar|7z|xz|bz2|zst|jar|pdf|wasm)$/i.test(path) ||
    /^(?:%PDF-|%!PS-Adobe|SQLite format)/.test(value)
  )
    throw new RuntimeError("publication_binary_unsupported");
  return value;
}

export class PublicationScanner {
  private readonly root: string;
  private readonly secrets: SecretAccessor;
  private readonly executable: string;
  constructor(
    root: string,
    secrets: SecretAccessor,
    executable = "/opt/orm-runtime/bin/gitleaks",
  ) {
    this.root = root;
    this.secrets = secrets;
    this.executable = executable;
  }

  async scan(value: unknown, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.secrets.containsCredentials(value))
      throw new RuntimeError("publication_secret");
    const pieces: string[] = [];
    let bytes = 0;
    function append(text: string) {
      bytes += Buffer.byteLength(text);
      if (bytes > 32 * 1024 * 1024)
        throw new RuntimeError("publication_size_limit");
      pieces.push(text);
    }
    function strings(item: unknown, depth = 0, yamlRequired = false) {
      if (depth > 64) throw new RuntimeError("publication_size_limit");
      if (typeof item === "string") {
        append(item);
        if (Buffer.byteLength(item) > 1024 * 1024)
          throw new RuntimeError("publication_size_limit");
        const documents = parseAllDocuments(item, {
          schema: "failsafe",
          strict: true,
          uniqueKeys: false,
          logLevel: "silent",
          prettyErrors: false,
        });
        const complete = documents.every(
          (document) => !document.errors.length && !document.warnings.length,
        );
        // General text need not be YAML; artifacts identified as YAML must parse completely.
        if (!complete && yamlRequired)
          throw new RuntimeError("publication_structured_invalid");
        if (complete) {
          const pending: Array<{ node: unknown; depth: number }> =
            documents.map((document) => ({
              node: document.contents,
              depth: 0,
            }));
          let visited = 0;
          while (pending.length) {
            signal.throwIfAborted();
            const { node, depth: level } = pending.pop()!;
            if (++visited > 100000 || level > 64)
              throw new RuntimeError("publication_size_limit");
            if (isScalar(node)) {
              if (typeof node.value === "string" && node.value !== item)
                strings(node.value, depth + 1);
            } else if (isPair(node)) {
              pending.push(
                { node: node.key, depth: level + 1 },
                { node: node.value, depth: level + 1 },
              );
            } else if (isCollection(node)) {
              for (const child of node.items)
                pending.push({ node: child, depth: level + 1 });
            } else if (node !== null && !isAlias(node)) {
              throw new RuntimeError("publication_structured_invalid");
            }
          }
        }
        // Decode quoted scalars without discarding duplicate structured keys or importing YAML aliases.
        for (const match of item.matchAll(
          /"(?:[^"\\]|\\[\s\S])*"|'(?:[^']|'')*'/g,
        )) {
          if (!/[\\\r\n]/.test(match[0]) && !match[0].includes("''")) continue;
          const document = parseDocument(match[0], {
            schema: "failsafe",
            strict: true,
            logLevel: "silent",
            prettyErrors: false,
          });
          if (
            document.errors.length ||
            document.warnings.length ||
            !isScalar(document.contents) ||
            typeof document.contents.value !== "string"
          )
            continue;
          strings(document.contents.value, depth + 1);
        }
      } else if (Array.isArray(item))
        item.forEach((entry) => strings(entry, depth + 1));
      else if (item && typeof item === "object")
        for (const [key, value] of Object.entries(item)) {
          strings(key, depth + 1);
          const file = item as Record<string, unknown>;
          strings(
            value,
            depth + 1,
            key === "text" &&
              typeof file.path === "string" &&
              /\.ya?ml$/i.test(file.path) &&
              file.mode !== "120000",
          );
        }
    }
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string")
      throw new RuntimeError("publication_size_limit");
    append(serialized);
    strings(value);
    if (this.secrets.containsCredentials(pieces))
      throw new RuntimeError("publication_secret");
    await trustedExecutable(this.executable);
    await rootDirectory(this.root);
    const directory = await mkdtemp(join(this.root, "scan-"));
    try {
      await writeFile(join(directory, "policy.toml"), scannerPolicy.config, {
        mode: 0o400,
      });
      await writeFile(join(directory, ".gitleaksignore"), "", { mode: 0o400 });
      await this.execute(["version"], directory, undefined, signal, true);
      // Framing prevents Gitleaks from silently classifying a text payload as a binary file.
      await this.execute(
        [
          "stdin",
          "--config",
          join(directory, "policy.toml"),
          "--gitleaks-ignore-path",
          join(directory, ".gitleaksignore"),
          "--ignore-gitleaks-allow",
          "--redact=100",
          "--no-banner",
          "--log-level=error",
          "--max-target-megabytes=0",
        ],
        directory,
        `publication scan\n${pieces.join("\npublication field\n")}`,
        signal,
      );
    } finally {
      await rm(directory, { recursive: true });
    }
  }

  private execute(
    args: string[],
    cwd: string,
    input: string | undefined,
    signal: AbortSignal,
    version = false,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, args, {
        cwd,
        env: { PATH: "/usr/bin:/bin", HOME: cwd, TMPDIR: cwd },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "",
        size = 0,
        failed = false;
      const stop = () => {
        failed = true;
        child.kill("SIGKILL");
      };
      const timer = setTimeout(stop, 30000);
      signal.addEventListener("abort", stop, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (version) output += chunk.toString();
        if (size > 65536) stop();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 65536) stop();
      });
      child.on("error", () => {
        failed = true;
      });
      child.stdin.on("error", () => {
        failed = true;
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
        if (signal.aborted && code === null) reject(signal.reason);
        else if (
          failed ||
          code !== 0 ||
          (version && output.trim() !== "8.30.1")
        )
          reject(new RuntimeError("publication_scan_failed"));
        else resolve();
      });
      child.stdin.end(input);
      if (signal.aborted) stop();
    });
  }
}
