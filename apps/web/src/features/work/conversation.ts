import type { AgentEvent, ConversationItem } from "@nexus/core";
export function applyConversationEvent(
  items: ConversationItem[],
  event: AgentEvent,
): ConversationItem[] {
  const d = event.data ?? {},
    message = typeof d.messageId === "string" ? d.messageId : undefined;
  const id = message
    ? `message:${event.kind}:${message}`
    : typeof d.toolCallId === "string"
      ? `tool:${d.toolCallId}`
      : typeof d.permissionId === "string"
        ? `permission:${d.permissionId}`
        : `event:${event.id}`;
  if (event.kind === "status" && message)
    return items.map((item) =>
      item.id === `message:user:${message}`
        ? { ...item, data: { ...item.data, ...d }, updatedAt: event.createdAt }
        : item,
    );
  // Status-only events update the Agent header, not the readable timeline.
  if (event.kind === "status") return items;
  const old = items.find((item) => item.id === id),
    append = ["assistant", "thought"].includes(event.kind) && d.delta === true;
  const item: ConversationItem = {
    id,
    agentId: event.agentId,
    kind: event.kind,
    text: (append ? (old?.text ?? "") + event.text : event.text).slice(-524288),
    data: { ...old?.data, ...d },
    sequence: old?.sequence ?? event.id,
    createdAt: old?.createdAt ?? event.createdAt,
    updatedAt: event.createdAt,
    roundId: event.roundId,
  };
  return old
    ? items.map((value) => (value.id === id ? item : value))
    : [...items, item];
}
