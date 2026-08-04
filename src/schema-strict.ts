/**
 * schema-strict.ts — 工具 schema strict 化（对齐 mcp_integration/schema_strict.py）
 *
 * OPENAI_TOOL_STRICT env 已移除（ADR-0007）：始终 sanitize schema，
 * strict 语义由 pi-ai 的 constrainedSampling（prefer）承接。
 */

export function isToolStrictEnabled(): boolean {
  return true;
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
  out.function.strict = true;
  out.function.parameters = sanitizeParametersForApi(toolName, out.function.parameters);
  return out;
}
