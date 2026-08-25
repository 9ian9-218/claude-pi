#!/usr/bin/env node
/**
 * bin/cpi.js — 生产入口 shim（打包隐患 05）
 *
 * tsx 已在 dependencies（原在 devDependencies，生产安装后 cpi 无法运行）。
 * shim 显式启用 tsx loader 后加载 TS 源码，免构建直接分发（保持免构建取向）。
 */
import "tsx";
import "../src/cli.ts";
