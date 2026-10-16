import { constants, type Stats } from "node:fs";
import {
  chmod,
  chown,
  lstat,
  mkdir,
  open,
  readdir,
  rmdir,
  unlink,
} from "node:fs/promises";
import { join, parse, relative, resolve } from "node:path";
import { RuntimeError } from "../../domain/agents.ts";

export async function rootDirectory(path: string, mode = 0o700) {
  let current = parse(resolve(path)).root;
  for (const part of relative(current, resolve(path)).split("/")) {
    current = join(current, part);
    await mkdir(current, {
      mode: current === resolve(path) ? mode : 0o700,
    }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new RuntimeError("workspace_permissions");
  }
  const stat = await lstat(path);
  if (stat.uid !== process.getuid!() || stat.mode & 0o022)
    throw new RuntimeError("workspace_permissions");
  await chmod(path, mode);
}

export async function ownedDirectory(path: string, uid: number, gid: number) {
  await mkdir(path, { mode: 0o700 });
  await chown(path, uid, gid);
}

export async function walkTree(
  root: string,
  visit: (
    path: string,
    reference: string,
    stat: Stats,
  ) => Promise<void | boolean>,
  uid?: number,
) {
  async function directory(path: string, reference: string) {
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    ).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!handle) return;
    try {
      const directoryPath = `/proc/self/fd/${handle.fd}`;
      for (const name of (await readdir(directoryPath)).sort()) {
        const child = join(directoryPath, name),
          ref = reference ? `${reference}/${name}` : name;
        let stat;
        try {
          stat = await lstat(child);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        if (uid !== undefined && stat.uid !== uid) continue;
        const descend = await visit(child, ref, stat);
        if (stat.isDirectory() && descend !== false)
          await directory(child, ref);
      }
    } finally {
      await handle.close();
    }
  }
  await directory(root, "");
}

export async function treeBytes(root: string, limit: number, uid?: number) {
  let bytes = 0;
  await walkTree(
    root,
    async (_path, _ref, stat) => {
      bytes += stat.size;
      if (bytes > limit) throw new RuntimeError("storage_limit");
    },
    uid,
  );
  return bytes;
}

export async function cleanTemporary(uid: number) {
  for (const root of ["/tmp", "/var/tmp", "/dev/shm", "/run/lock"]) {
    let stat;
    try {
      stat = await lstat(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink()) continue;
    const directories: string[] = [];
    await walkTree(
      root,
      async (path, ref, entry) => {
        if (entry.isDirectory()) directories.push(join(root, ref));
        else await unlink(path);
      },
      uid,
    );
    for (const path of directories.reverse()) await rmdir(path);
  }
}
