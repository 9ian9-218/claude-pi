/**
 * schema-strict.ts — OpenAI strict 模式 schema 处理（对齐 mcp_integration/schema_strict.py）
 *
 * 仅在 API 导出时变换 schema，不修改工具定义本身。
 * OPENAI_TOOL_STRICT=false 时去掉 strict 字段（兼容拒绝 strict 字段的 API）。
 */
import { getToolStrict } from "./config.ts";

export function isToolStrictEnabled(): boolean {
  return getToolStrict();
}

/** 递归 enforce strict 规则：object → additionalProperties=false + required=全部属性；array → 递归 items */
export function sanitizeSchemaForStrict(schema: unknown): unknown {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return schema;
  }
  const out: Record<string, unknown> = { ...(schema as Record<string, unknown>) };
  const nodeType = out["type"];
  if (nodeType === "object") {
    const props = out["properties"];
    if (typeof props === "object" && props !== null) {
      const sanitizedProps: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
        sanitizedProps[k] = sanitizeSchemaForStrict(v);
      }
      out["properties"] = sanitizedProps;
      out["required"] = Object.keys(sanitizedProps);
    }
    const ap = out["additionalProperties"];
    // 对齐 Python：仅当缺失或为 dict 时改为 false；显式 true 保留
    if (ap === undefined || (typeof ap === "object" && ap !== null)) {
      out["additionalProperties"] = false;
    }
    return out;
  }
  if (nodeType === "array") {
    const items = out["items"];
    if (typeof items === "object" && items !== null) {
      out["items"] = sanitizeSchemaForStrict(items);
    }
  }
  return out;
}

export function sanitizeParametersForApi(
  _toolName: string,
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  if (!isToolStrictEnabled()) return parameters;
  return sanitizeSchemaForStrict(parameters) as Record<string, unknown>;
}

export interface OpenaiTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
}

export function sanitizeOpenaiTool(toolName: string, openaiTool: OpenaiTool): OpenaiTool {
  const out: OpenaiTool = structuredClone(openaiTool);
  if (!isToolStrictEnabled()) {
    delete out.function.strict;
    return out;
  }
  out.function.strict = true;
  out.function.parameters = sanitizeParametersForApi(toolName, out.function.parameters);
  return out;
}
