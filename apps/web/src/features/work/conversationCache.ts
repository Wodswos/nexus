import type { ConversationItem, ConversationSnapshot } from "@nexus/core";
import type { WorkspaceAgentView } from "@/shared/agentWorkspaceApi";
const prefix = (user: string) => `nexus:conversation-cache:${user}:`;
export function clearConversationCache(user: string, id: string) {
  try {
    localStorage.removeItem(prefix(user) + id);
  } catch {}
}
export function readConversationCache(
  user: string,
  id: string,
): { agent: WorkspaceAgentView; snapshot: ConversationSnapshot } | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(prefix(user) + id) || "null");
    if (value?.agent?.id === id && Array.isArray(value.snapshot?.items))
      return value;
  } catch {}
}
/** Bounded, account-scoped reading cache, never an offline command queue. */
export function cacheConversation(
  user: string,
  agent: WorkspaceAgentView,
  snapshot: ConversationSnapshot,
  items: ConversationItem[],
) {
  try {
    const compact = items.slice(-100).map((item) => ({
      ...item,
      text: item.text.slice(0, 8000),
      data: item.kind === "tool" ? { status: item.data?.status } : item.data,
    }));
    const value = JSON.stringify({
      agent,
      snapshot: { ...snapshot, items: compact, runs: [], messages: [] },
      savedAt: Date.now(),
    });
    if (value.length > 700000) return;
    localStorage.setItem(prefix(user) + agent.id, value);
    const keys = Object.keys(localStorage)
      .filter(
        (k) => k.startsWith(prefix(user)) && k !== prefix(user) + agent.id,
      )
      .sort(
        (a, b) =>
          JSON.parse(localStorage.getItem(b)!).savedAt -
          JSON.parse(localStorage.getItem(a)!).savedAt,
      );
    for (const key of keys.slice(4)) localStorage.removeItem(key);
  } catch {}
}
