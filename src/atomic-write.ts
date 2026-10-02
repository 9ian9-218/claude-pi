/**
 * atomic-write.ts — 原子落盘（写临时文件 → rename 替换）
 *
 * 状态文件（会话 / 任务看板 / 团队配置 / 设置 / 收件箱 / 记忆）被中断写坏 = 静默丢数据。
 * 同一文件系统内 rename 是原子的：读者只会看到旧版本或新版本，不会看到半截文件。
 * 失败时清掉临时文件再抛出，不掩盖原错误。
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function writeFileAtomic(filePath: string, data: string | Buffer): void {
  const tmp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp-${randomUUID()}`,
  );
  try {
    const mode = fs.existsSync(filePath) ? fs.statSync(filePath).mode & 0o777 : 0o600;
    fs.writeFileSync(tmp, data, { mode });
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // 清理失败不掩盖原始错误
    }
    throw e;
  }
}
