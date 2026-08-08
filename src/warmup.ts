/**
 * warmup.ts — 重模块后台预热（架构 A）
 *
 * pi-ai / pi-coding-agent / typebox 的首次同步 import 会阻塞事件循环
 * 2–7 秒（tsx 逐文件转译）。warmUp() 在启动后 idle 时后台预热，把
 * 加载成本移出交互路径；查询路径的懒加载仍兜底（预热失败静默）。
 *
 * 深接口：调用方只需 warmUp()（幂等、永不抛）。
 */
let warmed = false;
let warming: Promise<void> | null = null;

/** 预热整体超时：无凭据环境 create 可能挂起，超时后放弃（后台继续无害） */
const WARMUP_TIMEOUT_MS = 10_000;

function withTimeout(p: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), ms);
    p.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

export function warmUp(): Promise<void> {
  if (warmed) return Promise.resolve();
  if (warming) return warming;
  warming = withTimeout(
    (async () => {
      try {
        // pi-ai 模块树（含 typebox / zod 等重依赖）
        await import("@earendil-works/pi-ai");
        // 模型运行时（pi-coding-agent，最大模块树；create 会解析凭据/模型）
        const { getModelRuntime } = await import("./ai-runtime.ts");
        await getModelRuntime();
        warmed = true;
      } catch {
        // 无模型配置 / 凭据缺失等——静默；查询路径的懒加载会再抛给调用方
      }
    })(),
    WARMUP_TIMEOUT_MS,
  );
  return warming;
}

/** 测试/诊断：重置预热状态 */
export function resetWarmUp(): void {
  warmed = false;
  warming = null;
}
