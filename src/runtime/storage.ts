import { constants } from "node:fs";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

const uid = Number(process.argv[2]),
  limit = Number(process.argv[3]);
if (
  process.getuid?.() !== 0 ||
  process.geteuid?.() !== 0 ||
  ![10001, 10002, 10003].includes(uid) ||
  !Number.isSafeInteger(limit) ||
  limit < 0
)
  throw new Error("monitor_failed");

// Root real/saved identities protect this credential-free probe from worker signals and ptrace while effective identities permit /proc inspection.
process.setgroups!([]);
process.setegid!(uid);
process.seteuid!(uid);

const files = new Map<string, bigint>(),
  measured = new Set<string>(),
  mappings = new Set<string>();
let bytes = 0n,
  retryDeadline: number | undefined;
for (const pid of await readdir("/proc")) {
  if (!/^\d+$/.test(pid)) continue;
  let directory;
  try {
    // Pin the process directory so retries cannot inspect a reused PID.
    directory = await open(
      `/proc/${pid}`,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const path = `/proc/self/fd/${directory.fd}`,
      status = await readFile(`${path}/status`, "utf8");
    if (
      !new RegExp(`^Uid:\\s+${uid}\\s+${uid}\\s+${uid}\\s+${uid}$`, "m").test(
        status,
      )
    )
      continue;
    for (;;) {
      const found = new Map<string, bigint>(),
        seen = new Set<string>(),
        mapped = new Set<string>();
      let additional = 0n;
      try {
        for (const fd of await readdir(`${path}/fd`)) {
          let entry;
          try {
            entry = await stat(`${path}/fd/${fd}`, { bigint: true });
          } catch (error) {
            if (
              ["ENOENT", "ESRCH"].includes(
                (error as NodeJS.ErrnoException).code ?? "",
              )
            )
              continue;
            throw error;
          }
          if (!entry.isFile()) continue;
          const key = `${entry.dev}:${entry.ino}`;
          seen.add(key);
          if (entry.nlink !== 0n) continue;
          const previous = found.get(key) ?? files.get(key) ?? 0n;
          if (entry.size > previous) {
            additional += entry.size - previous;
            found.set(key, entry.size);
          }
          if (bytes + additional > BigInt(limit)) break;
        }
        if (bytes + additional <= BigInt(limit))
          for (const line of (await readFile(`${path}/maps`, "utf8")).split(
            "\n",
          )) {
            if (!line.endsWith(" (deleted)")) continue;
            const fields = line.trim().split(/\s+/, 6),
              inode = fields[4];
            if (inode === "0") continue;
            const [major, minor] = fields[3]
                .split(":")
                .map((value) => BigInt(`0x${value}`)),
              device =
                ((major & 0xfffn) << 8n) |
                ((major & ~0xfffn) << 32n) |
                (minor & 0xffn) |
                ((minor & ~0xffn) << 12n);
            mapped.add(`${device}:${inode}`);
          }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EACCES") {
          const current = await readFile(`${path}/status`, "utf8");
          if (
            /^State:\s+[ZX]\b/m.test(current) &&
            /^Threads:\s+1$/m.test(current)
          )
            break;
          retryDeadline ??= performance.now() + 250;
          const remaining = retryDeadline - performance.now();
          if (remaining > 0) {
            await delay(Math.min(25, remaining));
            continue;
          }
        }
        throw error;
      }
      bytes += additional;
      for (const [key, size] of found) files.set(key, size);
      for (const key of seen) measured.add(key);
      for (const key of mapped) mappings.add(key);
      break;
    }
  } catch (error) {
    if (
      !["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")
    )
      throw error;
  } finally {
    await directory?.close();
  }
  if (bytes > BigInt(limit)) break;
}
if (bytes <= BigInt(limit) && [...mappings].some((key) => !measured.has(key)))
  throw new Error("monitor_failed");
console.log(bytes > BigInt(limit) ? "storage_limit" : String(bytes));
