import { rm } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targetGroups = {
  protocol: ["packages/protocol/dist", ".tsbuildinfo/protocol.tsbuildinfo"],
  server: ["packages/server/dist", ".tsbuildinfo/server.tsbuildinfo"],
  sdk: ["packages/sdk/dist", ".tsbuildinfo/sdk.tsbuildinfo"],
  standalone: ["apps/standalone/dist", ".tsbuildinfo/standalone.tsbuildinfo"],
  all: [
    "packages/protocol/dist",
    "packages/server/dist",
    "packages/sdk/dist",
    "apps/standalone/dist",
    ".tsbuildinfo",
  ],
};

const group = process.argv[2];
const targets = targetGroups[group];
if (!targets) {
  throw new Error(`未知 clean target：${group ?? "<missing>"}`);
}

for (const target of targets) {
  const absolute = resolve(root, target);
  const fromRoot = relative(root, absolute);
  if (fromRoot.startsWith("..") || fromRoot === "") {
    throw new Error(`拒绝清理 workspace 外路径：${target}`);
  }
  await rm(absolute, { recursive: true, force: true });
}
