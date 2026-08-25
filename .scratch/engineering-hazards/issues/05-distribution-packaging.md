---
title: "研究：分发打包（bin 指向 TS 源、tsx 在 devDependencies）"
labels: ["wayfinder:research"]
parent: ../map.md
---

## Question

`"bin": {"cpi": "src/cli.ts"}` 指向 **TypeScript 源文件**，而运行时依赖 `tsx`（在 **devDependencies**）。`npm install`（生产模式 / `--omit=dev`）后 `cpi` 无法启动（node 直接跑 TS 报 SyntaxError）。实证：

1. `npm pack` 产物清单（files 字段）→ 在干净环境 `npm install` 后实际运行行为（实测）。
2. 修复候选：tsx 升为 dependencies / 加 build 步骤产 dist+声明文件 / 改用 pi 的启动方式（jiti? node --import?）——各方案的包体积、冷启动、双源维护代价。
3. engines (node>=22.18) 的现实约束；ESM 与 .ts 直接发布的生态惯例。

结论产出：打包问题确认 + 推荐方案与代价（不实施）。

## Resolution

已实施：tsx 从 devDependencies 移至 dependencies；新增 `bin/cpi.js`（import "tsx" +
加载 src/cli.ts，免构建）；bin 字段指向 shim；files 加 bin/。
测试：node 直接跑 bin/cpi.js --version 成功。
