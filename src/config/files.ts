import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { ConfigurationError } from "./errors.ts";

export async function checkPath(
  path: string,
  code: "config_unreadable" | "bundle_invalid",
) {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of relative(current, absolute).split("/")) {
    current = join(current, part);
    const stats = await lstat(current);
    if (stats.isSymbolicLink()) throw new ConfigurationError(code);
  }
}

export function isContainedReference(reference: string) {
  return (
    !isAbsolute(reference) &&
    !reference.includes("\\") &&
    !reference
      .split("/")
      .some((part) => part === ".." || part === "." || part === "") &&
    ![...reference].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  );
}

export function containedPath(root: string, reference: string) {
  if (!isContainedReference(reference))
    throw new ConfigurationError("bundle_invalid");
  const path = resolve(root, reference);
  if (!path.startsWith(`${resolve(root)}/`))
    throw new ConfigurationError("bundle_invalid");
  return path;
}

export async function readRegularFile(path: string, protectedConfig = false) {
  const code = protectedConfig ? "config_unreadable" : "bundle_invalid";
  try {
    await checkPath(path, code);
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new ConfigurationError(code);
      if (protectedConfig) {
        const parent = await lstat(dirname(resolve(path)));
        if (
          stat.uid !== 0 ||
          (stat.mode & 0o077) !== 0 ||
          (stat.mode & 0o400) === 0 ||
          parent.uid !== 0 ||
          (parent.mode & 0o022) !== 0
        )
          throw new ConfigurationError("config_permissions");
      } else if ((stat.mode & 0o022) !== 0)
        throw new ConfigurationError("bundle_invalid");
      const content = Buffer.alloc(1024 * 1024 + 1);
      let length = 0;
      while (length < content.length) {
        const result = await handle.read(
          content,
          length,
          content.length - length,
          null,
        );
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length > 1024 * 1024) throw new ConfigurationError(code);
      return content.subarray(0, length);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError(code);
  }
}
