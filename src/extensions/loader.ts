/**
 * loader.ts — 扩展加载器（ADR-0006：三位置 + 动态加载 + /reload）
 *
 * 位置：.agent/extensions/*.ts（项目内）、~/.claude-pi/extensions/*.ts（用户级）、
 * -e <path>（CLI 临时）。无信任门控（README 警示：扩展即任意代码）。
 * 加载用 import() + 时间戳 query：reload 时不命中模块缓存。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PROJECT_ROOT, resolveAgentDirs } from "../config.ts";
import { createExtensionApi, type ExtensionAPI } from "./api.ts";

export interface LoadedExtension {
  path: string;
  api: ExtensionAPI;
}

function projectExtensionsDir(): string {
  return resolveAgentDirs(PROJECT_ROOT).extensionsDir;
}

function userExtensionsDir(): string {
  return path.join(os.homedir(), ".claude-pi", "extensions");
}

/** 扫描扩展文件（排序保证确定性） */
export function discoverExtensionFiles(cliPaths: string[] = []): string[] {
  const files: string[] = [];
  const collect = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, f);
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        const index = path.join(p, "index.ts");
        if (fs.existsSync(index)) files.push(index);
      } else if (f.endsWith(".ts") || f.endsWith(".mjs") || f.endsWith(".cjs")) {
        files.push(p);
      }
    }
  };
  collect(userExtensionsDir());
  collect(projectExtensionsDir());
  for (const p of cliPaths) {
    if (fs.existsSync(p)) files.push(path.resolve(p));
  }
  return files;
}

export class ExtensionManager {
  private loaded: LoadedExtension[] = [];
  private deps: {
    registerTool: (t: import("./api.ts").ExtensionToolDef) => void;
    registerCommand: (n: string, h: import("./api.ts").ExtensionCommandHandler) => void;
    appendEntry: (t: string, d?: unknown) => string;
    beforeLoad?: () => void;
  };

  constructor(deps: ExtensionManager["deps"]) {
    this.deps = deps;
  }

  /** 加载全部扩展（幂等：先清空再加载）；import() + 时间戳 query 绕过模块缓存 */
  async load(cliPaths: string[] = []): Promise<LoadedExtension[]> {
    this.unload();
    this.deps.beforeLoad?.();
    const files = discoverExtensionFiles(cliPaths);
    for (const file of files) {
      try {
        const url =
          pathToFileURL(file).href + `?t=${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
        const mod = (await import(url)) as unknown;
        const factory = (mod as { default?: unknown }).default ?? mod;
        if (typeof factory !== "function") {
          console.log(`  \x1b[33m[ext] skip ${file}: no default export function\x1b[0m`);
          continue;
        }
        const api = createExtensionApi({
          registerTool: this.deps.registerTool,
          registerCommand: this.deps.registerCommand,
          appendEntry: this.deps.appendEntry,
        });
        factory(api);
        this.loaded.push({ path: file, api });
        console.log(`  \x1b[32m[ext] loaded ${file}\x1b[0m`);
      } catch (e) {
        console.log(`  \x1b[31m[ext] failed to load ${file}: ${String((e as Error).message)}\x1b[0m`);
      }
    }
    return this.loaded;
  }

  /** 热重载（/reload） */
  reload(cliPaths: string[] = []): Promise<LoadedExtension[]> {
    return this.load(cliPaths);
  }

  unload(): void {
    this.loaded = [];
  }

  getLoaded(): LoadedExtension[] {
    return [...this.loaded];
  }
}
