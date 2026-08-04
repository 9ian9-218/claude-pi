# 19 — MCP 集成（独立里程碑）

**What to build:** 外部能力接入：@modelcontextprotocol/sdk 移植 hub（服务器发现/命名空间归一化）、names、schema_strict、本地 MCP server（原 local_mcp_server.py 的 TS 版）；`.agent/mcp.json` 配置加载。范围对应 Python 版 mcp_integration/ 全部模块。

**Blocked by:** 02b 工具闭环

**Status:** ready-for-agent

- [ ] 配置的 MCP server 被发现、工具命名空间归一化
- [ ] 本地 MCP server 可启动并被 hub 接入
- [ ] 严格 schema 校验行为与 Python 版一致
- [ ] MCP 工具的 vitest 测试绿灯（mock server）
