import { readFile, readdir, stat } from "node:fs/promises";

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
let bytes = 0n;
for (const pid of await readdir("/proc")) {
  if (!/^\d+$/.test(pid)) continue;
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    if (
      !new RegExp(`^Uid:\\s+${uid}\\s+${uid}\\s+${uid}\\s+${uid}$`, "m").test(
        status,
      )
    )
      continue;
    for (const fd of await readdir(`/proc/${pid}/fd`)) {
      let entry;
      try {
        entry = await stat(`/proc/${pid}/fd/${fd}`, { bigint: true });
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
      measured.add(key);
      if (entry.nlink !== 0n) continue;
      const previous = files.get(key) ?? 0n;
      if (entry.size > previous) {
        bytes += entry.size - previous;
        files.set(key, entry.size);
      }
      if (bytes > BigInt(limit)) break;
    }
    for (const line of (await readFile(`/proc/${pid}/maps`, "utf8")).split(
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
      mappings.add(`${device}:${inode}`);
    }
  } catch (error) {
    if (
      !["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")
    )
      throw error;
  }
  if (bytes > BigInt(limit)) break;
}
if (bytes <= BigInt(limit) && [...mappings].some((key) => !measured.has(key)))
  throw new Error("monitor_failed");
console.log(bytes > BigInt(limit) ? "storage_limit" : String(bytes));
