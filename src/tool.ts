/**
 * tool.ts — 工具出口（兼容层）
 *
 * 实现已拆分到 src/tools/*：
 * - tools/runtime.ts  ToolRuntime（抽象 + 注册表 + 执行/校验/角色面）
 * - tools/path.ts     路径校验
 * - tools/bash.ts     run_bash
 * - tools/file.ts     read/write/edit/glob/grep
 * - tools/todo.ts     todo_write
 * - tools/skill.ts    load_skill
 * - tools/tasks-board.ts 任务看板工具
 * - tools/agent-tools.ts subagent/teammate 工具
 */
export {
  Tool,
  buildTool,
  type ExecuteFn,
  type ToolCallLike,
  BUILTIN_TOOLS,
  TOOL_MAP,
  registerExtensionTool,
  getOpenaiTools,
  getToolParameters,
  executeToolCall,
  validateArgs,
  isToolAllowedForRole,
  ROLE_TOOL_ALLOWLIST,
} from "./tools/runtime.ts";
export { checkPath, safePath } from "./tools/path.ts";
export { RUN_BASH_TOOL } from "./tools/bash.ts";
export {
  READ_FILE_TOOL,
  WRITE_FILE_TOOL,
  EDIT_FILE_TOOL,
  GLOB_TOOL,
  GREP_TOOL,
} from "./tools/file.ts";
export { TODO_WRITE_TOOL, type TodoItem, CURRENT_TODOS } from "./tools/todo.ts";
export { LOAD_SKILL_TOOL } from "./tools/skill.ts";
export {
  CREATE_TASK_TOOL,
  LIST_TASKS_TOOL,
  GET_TASK_TOOL,
  CLAIM_TASK_TOOL,
  COMPLETE_TASK_TOOL,
} from "./tools/tasks-board.ts";
export {
  SUBAGENT_TASK_TOOL,
  DELEGATE_TASK_TOOL,
  SPAWN_TEAMMATE_TOOL,
  CREATE_TEAM_TOOL,
  SEND_MESSAGE_TOOL,
  LIST_TEAMMATES_TOOL,
  SHUTDOWN_TEAMMATE_TOOL,
  SUBAGENT_EXCLUDED,
  spawnSubagent,
} from "./tools/agent-tools.ts";
