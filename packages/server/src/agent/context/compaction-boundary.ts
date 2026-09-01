import type { Event } from "../../conversation/events.js";

/** 返回所有闭合且位于最新 user query 之前的 checkpoint 候选，按 seq 升序。 */
export function findSafeCompactionBoundaries(
  events: Event[],
  afterSeq: number,
  protectedUserSeq: number
): number[] {
  const openToolCalls = new Set<string>();
  let pendingThinking = false;
  const boundaries: number[] = [];

  for (const event of events) {
    if (event.seq <= afterSeq || event.seq >= protectedUserSeq) continue;
    let relevant = false;
    switch (event.type) {
      case "thinking_finished":
      case "thinking_completed":
        pendingThinking = true;
        relevant = true;
        break;
      case "agent_message":
        pendingThinking = false;
        for (const call of event.toolCalls) openToolCalls.add(call.id);
        relevant = true;
        break;
      case "tool_result":
        openToolCalls.delete(event.toolCallId);
        relevant = true;
        break;
      case "user_message":
        relevant = true;
        break;
      default:
        break;
    }
    if (relevant && !pendingThinking && openToolCalls.size === 0) {
      boundaries.push(event.seq);
    }
  }
  return boundaries;
}
