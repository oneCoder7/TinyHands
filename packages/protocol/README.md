# @tinyhands/protocol

Versioned, JSON-safe public protocol types for Tinyhands.

This package contains REST DTOs, public event unions, stable error codes, stream
control types, and runtime validators shared by `@tinyhands/server` and
`@tinyhands/sdk`. It has no Server or provider SDK dependency.

Protocol version 2 adds `ToolPolicyMode`, generic Human Interaction request /
response maps, `thinking_completed`, and `agent_completed`. The Server can read
persisted v1 event names, while new public streams emit only v2 names.
