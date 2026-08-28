/**
 * frontmatter.ts — Markdown 前置元数据解析（memory 与 skill-load 共用）
 */
export function parseFrontmatter(text: string): [Record<string, string>, string] {
  if (!text.startsWith("---")) return [{}, text];
  const parts = text.split("---", 3);
  if (parts.length < 3) return [{}, text];
  const meta: Record<string, string> = {};
  for (const line of parts[1].trim().split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
      meta[k] = v;
    }
  }
  return [meta, parts[2].trim()];
}
