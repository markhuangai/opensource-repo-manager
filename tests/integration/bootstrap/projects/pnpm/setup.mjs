import fs from "node:fs";
if (process.getuid() === 0) throw Error("setup ran as root");
for (const key of [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "ORM_RELAY_AUTH",
  "ANTHROPIC_API_KEY",
])
  if (process.env[key]) throw Error("credential inherited");
fs.writeFileSync(".setup-uid", String(process.getuid()));
