import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // 与 tsconfig.test.json 的 workspace paths 保持一致。否则 Vitest 会把测试中的
  // source import 和包名 import 分别加载为 src/dist 两份模块，导致 Error class 的
  // instanceof 等模块身份判断失效。
  resolve: {
    alias: [
      {
        find: /^@tinyhands\/protocol$/,
        replacement: fileURLToPath(
          new URL("./packages/protocol/src/index.ts", import.meta.url)
        ),
      },
      {
        find: /^@tinyhands\/server$/,
        replacement: fileURLToPath(
          new URL("./packages/server/src/index.ts", import.meta.url)
        ),
      },
      {
        find: /^@tinyhands\/server\/http$/,
        replacement: fileURLToPath(
          new URL("./packages/server/src/http.ts", import.meta.url)
        ),
      },
      {
        find: /^@tinyhands\/sdk$/,
        replacement: fileURLToPath(
          new URL("./packages/sdk/src/index.ts", import.meta.url)
        ),
      },
    ],
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
  },
});
