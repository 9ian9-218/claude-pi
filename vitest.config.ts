import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // .agent/ 是运行时数据根（worktree 测试会留下陈旧副本），不参与测试发现
    exclude: ["**/node_modules/**", "**/.agent/**", "**/dist/**"],
  },
});
