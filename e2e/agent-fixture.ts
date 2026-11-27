import type { Page, Route } from "@playwright/test";
import { applyConversationEvent } from "../apps/web/src/features/work/conversation";
export function nativeAgent(id = "agent-1", name = "实现 Agent"): any {
  return {
    id,
    name,
    taskId: "agent-task",
    environmentId: "env-1",
    workspaceId: null,
    mode: "codex",
    command: "codex app-server",
    prompt: "初始任务",
    directory: "/work",
    worktree: false,
    state: "idle",
    stage: "ready",
    canResume: true,
    remoteSessionId: "session-" + id,
    createdAt: 1000,
    updatedAt: 1000,
  };
}
export function agentEvent(
  id: number,
  kind: string,
  text: string,
  agentId = "agent-1",
  data?: unknown,
): any {
  return { id, agentId, kind, text, data, createdAt: 1000 + id };
}
export const agentPanel = (page: Page) =>
  page.getByRole("main", { name: "Agent 工作台", exact: true });
export async function agentRoutes(
  page: Page,
  agents: any[],
  events: any[] = [],
  extra?: (route: Route, path: string, row: any) => Promise<boolean>,
) {
  await page.route("**/api/agents", (route) =>
    route.fulfill({ json: { data: agents } }),
  );
  await page.route("**/api/tasks/*/agents", (route) =>
    route.fulfill({ json: { data: agents } }),
  );
  await page.route("**/api/agents/**", async (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname,
      id = path.split("/")[3],
      row = agents.find((a) => a.id === id);
    if (await extra?.(route, path, row)) return;
    const history = events.filter((e) => e.agentId === id);
    if (path.endsWith("/stream"))
      return route.fulfill({ status: 503, body: "poll" });
    if (path.endsWith("/conversation"))
      return route.fulfill({
        json: {
          data: {
            items: history.reduce(applyConversationEvent, []),
            sequence: history.at(-1)?.id ?? 0,
            hasMore: false,
            messages: [],
            runs: [],
          },
        },
      });
    if (path.endsWith("/events"))
      return route.fulfill({
        json: {
          data: {
            events: history.filter(
              (e) => e.id > Number(url.searchParams.get("after")),
            ),
            nextCursor: history.at(-1)?.id ?? 0,
            hasMore: false,
          },
        },
      });
    if (path.endsWith("/rounds"))
      return route.fulfill({
        json: { data: row?.currentRound ? [row.currentRound] : [] },
      });
    if (path.endsWith("/terminal"))
      return route.fulfill({ json: { data: row?.pane || row?.terminalPane } });
    return route.fulfill({ json: { data: row } });
  });
}
