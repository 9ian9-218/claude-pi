import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  sanitizeOpenaiTool,
  sanitizeSchemaForStrict,
  type OpenaiTool,
} from "./schema-strict.ts";
import { getOpenaiTools } from "./tool.ts";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = { ...originalEnv };
});

const tool: OpenaiTool = {
  type: "function",
  function: {
    name: "read_file",
    description: "d",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
};

describe("schema-strict（S5）", () => {
  it("strict 开启（默认）：标记 strict:true 并补全 required", () => {
    const out = sanitizeOpenaiTool("read_file", tool);
    expect(out.function.strict).toBe(true);
  });


  it("sanitizeSchemaForStrict 递归：object 的 required 补全全部属性、array items 递归", () => {
    const schema = {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: { content: { type: "string" } },
            required: ["content"],
          },
        },
      },
    };
    const out = sanitizeSchemaForStrict(schema) as {
      properties: {
        todos: { items: { required: string[]; additionalProperties: boolean } };
      };
      required: string[];
      additionalProperties: boolean;
    };
    expect(out.required).toEqual(["todos"]);
    expect(out.additionalProperties).toBe(false);
    expect(out.properties.todos.items.required).toEqual(["content"]);
    expect(out.properties.todos.items.additionalProperties).toBe(false);
  });

  it("strict 恒开：getOpenaiTools 输出带 strict:true（ADR-0007 env 移除）", () => {
    const tools = getOpenaiTools(false);
    expect(tools.every((t) => t.function.strict === true)).toBe(true);
  });
});
