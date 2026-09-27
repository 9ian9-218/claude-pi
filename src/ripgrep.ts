/**
 * ripgrep.ts — rg 二进制解析与按需下载（对齐 pi 的 ensureTool 策略：
 * 工具缓存目录优先 → 系统 PATH；都没有则从 GitHub Releases 下载）。
 *
 * 缓存目录：$CLAUDE_PI_TOOLS_DIR 或 ~/.cache/claude-pi/bin。
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const RG_REPO = "BurntSushi/ripgrep";
const NETWORK_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const EXTRACT_TIMEOUT_MS = 60_000;

export const RG_BINARY_NAME = "rg" + (process.platform === "win32" ? ".exe" : "");

/** rg 缓存目录。 */
export function rgCacheDir(): string {
  return process.env.CLAUDE_PI_TOOLS_DIR ?? join(homedir(), ".cache", "claude-pi", "bin");
}

/** 缓存目录中的 rg 完整路径。 */
export function cachedRgPath(): string {
  return join(rgCacheDir(), RG_BINARY_NAME);
}

function commandExists(cmd: string): boolean {
  try {
    const r = spawnSync(cmd, ["--version"], { stdio: "pipe", timeout: 5_000 });
    return r.error === undefined || r.error === null;
  } catch {
    return false;
  }
}

/**
 * 查找可用的 rg：缓存目录（含显式 RIPGREP_PATH）优先，其次系统 PATH。
 * 找不到返回 null（不触发网络）。
 */
export function resolveRipgrep(): string | null {
  const local = cachedRgPath();
  if (existsSync(local)) return local;
  const explicit = process.env.RIPGREP_PATH;
  if (explicit && explicit.trim() !== "" && existsSync(explicit)) return explicit;
  if (commandExists("rg")) return "rg";
  return null;
}

// ── 下载 ──────────────────────────────────────────────────────────────────

async function latestRgVersion(): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${RG_REPO}/releases/latest`, {
    headers: { "User-Agent": "claude-pi" },
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const data = (await res.json()) as { tag_name?: string };
  const tag = data.tag_name;
  if (!tag) throw new Error("No release found");
  return tag.replace(/^v/, "");
}

function rgAssetName(version: string, plat: string, nodeArch: string): string | null {
  const a = nodeArch === "arm64" ? "aarch64" : "x86_64";
  if (plat === "darwin") return `ripgrep-${version}-${a}-apple-darwin.tar.gz`;
  if (plat === "linux") return `ripgrep-${version}-${a}-unknown-linux-musl.tar.gz`;
  if (plat === "win32") return `ripgrep-${version}-${a}-pc-windows-msvc.zip`;
  return null;
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Failed to download: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
}

function runExtraction(argv: string[]): string | null {
  try {
    const r = spawnSync(argv[0], argv.slice(1), { stdio: "pipe", timeout: EXTRACT_TIMEOUT_MS });
    if (r.status !== 0) {
      return (r.stderr?.toString() || `exit ${r.status}`).trim();
    }
    return null;
  } catch (e) {
    return String(e);
  }
}

/** 在解压目录中递归查找名字为 binaryName 的文件。 */
function findBinaryRecursively(dir: string, binaryName: string): string | null {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findBinaryRecursively(full, binaryName);
      if (found) return found;
    } else if (entry.isFile() && entry.name === binaryName) {
      return full;
    }
  }
  return null;
}

/**
 * 从 GitHub Releases 下载 ripgrep 到缓存目录并返回二进制路径
 * （对齐 pi 的 downloadTool：tar.gz/zip 解压 → 定位二进制 → chmod 755）。
 */
export async function downloadRipgrep(): Promise<string> {
  const plat = process.platform;
  const nodeArch = process.arch;
  const version = await latestRgVersion();
  const assetName = rgAssetName(version, plat, nodeArch);
  if (!assetName) throw new Error(`Unsupported platform: ${plat}/${nodeArch}`);

  const dir = rgCacheDir();
  mkdirSync(dir, { recursive: true });
  const archivePath = join(dir, assetName);
  const binaryPath = cachedRgPath();

  await downloadFile(`https://github.com/${RG_REPO}/releases/download/${version}/${assetName}`, archivePath);

  const extractDir = join(
    dir,
    `extract_tmp_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
  );
  mkdirSync(extractDir, { recursive: true });
  try {
    let fail: string | null;
    if (assetName.endsWith(".tar.gz")) {
      fail = runExtraction(["tar", "xzf", archivePath, "-C", extractDir]);
    } else {
      // Windows zip：优先 System32 的 bsdtar，其次 PowerShell Expand-Archive
      const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
      const bsdtarFail = runExtraction([
        join(systemRoot, "System32", "tar.exe"),
        "xf",
        archivePath,
        "-C",
        extractDir,
      ]);
      if (bsdtarFail) {
        fail = runExtraction([
          "powershell.exe",
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${extractDir}' -Force`,
        ]);
      } else {
        fail = null;
      }
    }
    if (fail) throw new Error(`Failed to extract ${assetName}: ${fail}`);

    const candidates = [join(extractDir, RG_BINARY_NAME)];
    for (const entry of readdirSync(extractDir, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(join(extractDir, entry.name, RG_BINARY_NAME));
    }
    let found: string | undefined = candidates.find((p) => existsSync(p));
    if (found === undefined) found = findBinaryRecursively(extractDir, RG_BINARY_NAME) ?? undefined;
    if (!found) throw new Error(`Binary not found in archive: expected ${RG_BINARY_NAME}`);
    renameSync(found, binaryPath);
    if (plat !== "win32") chmodSync(binaryPath, 0o755);
    return binaryPath;
  } finally {
    rmSync(archivePath, { force: true });
    rmSync(extractDir, { recursive: true, force: true });
  }
}

let ensurePromise: Promise<string> | null = null;

/**
 * 确保 rg 可用（解析 → 下载兜底）。单飞：并发调用共享同一次解析/下载。
 * 解析成功返回路径或命令名；下载失败不回填缓存，下次调用可重试。
 */
export function ensureRipgrep(): Promise<string> {
  if (ensurePromise === null) {
    ensurePromise = (async () => {
      const found = resolveRipgrep();
      if (found) return found;
      try {
        return await downloadRipgrep();
      } catch (e) {
        ensurePromise = null; // 失败不缓存：临时网络故障后允许重试
        throw new Error(
          `ripgrep (rg) is not available: ${(e as Error).message}. ` +
            "Install ripgrep on PATH, set RIPGREP_PATH, or allow the automatic download.",
        );
      }
    })();
  }
  return ensurePromise;
}
