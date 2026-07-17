import { describe, expect, it } from "vitest";
import { deriveDockerInstanceScope } from "../docker-runtime.js";

describe("Docker instance scope", () => {
  it("同一规范化 workspaceRoot 稳定，相邻实例不同", () => {
    expect(deriveDockerInstanceScope("/tmp/tinyhands/a/../a")).toBe(
      deriveDockerInstanceScope("/tmp/tinyhands/a")
    );
    expect(deriveDockerInstanceScope("/tmp/tinyhands/a")).not.toBe(
      deriveDockerInstanceScope("/tmp/tinyhands/b")
    );
  });
});
