# 文档状态与权威来源

当前公共 API、事件名称和集成示例以仓库根目录 `README.md`、各 package README、
`docs/design/tool-policy-human-interaction.md` 与
`docs/design/agent-module-refactor.md` 为准。

`docs/design/` 中带“已确认并实施”的 Markdown 文档描述当前实现；较早的 HTML 设计稿
和 `docs/study/` 是当时的调研/决策快照，可能保留 legacy 名称，用于解释迁移背景，
不应作为当前 API 合同。当前关键术语为：

- `ToolCallHandler.handleCalls()` 负责策略、approval、事件、Run Log 与恢复配对；
  `ToolCallExecutor.prepare/execute` 只负责参数校验和 Tool 执行
- `tool_call_dispatched/completed/skipped`
- `thinking_completed`、`agent_completed`
- `AgentLLMCall`、中立 stop reason `tool_call`
- `ContextPreparation`、`ResponseValidator` 是保留的两个 Step 扩展位置；不存在聚合
  `AgentLifecycle`
- `ConversationMetadata` 保存不可变 effective config；`AgentSession` 只保存当前进程的
  driver、interrupt 与 Runtime 生命周期状态
- `Runtime.start/close`
- protocol v2 Human Interaction：`human_interaction_requested/resolved`

Provider adapter 内的 `tool_use` 和 OpenSandbox SDK 内的 `kill()` 是外部协议原词，不属于
Tinyhands 中立领域命名。
