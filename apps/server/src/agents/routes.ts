import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { DB } from "../db";
import type { setupSync } from "../sync";
import type { WorkspaceService } from "../workspaces/service";
import { WorkspaceError } from "../workspaces/service";
import { RateLimit } from "../security";
import {
  AGENT_PRODUCT_PRESETS,
  type CreateWorkspaceAgent,
} from "../../../../packages/core/src/index";
import { DescriptionError } from "../taskDescriptions";
import { AgentService, type AgentServiceOptions } from "./service";

type CurrentUser = (context: Context) => string | null;
export function setupAgents(
  app: Hono,
  db: DB,
  workspaces: WorkspaceService,
  sync: () => Pick<ReturnType<typeof setupSync>, "withStore">,
  currentUser: CurrentUser,
  options: AgentServiceOptions = {},
) {
  const service = new AgentService(db, workspaces, sync, options);
  const browserLimit = new RateLimit(600, 60000),
    callbackLimit = new RateLimit(240, 60000);
  const error = (context: Context, reason: unknown) =>
    reason instanceof WorkspaceError || reason instanceof DescriptionError
      ? context.json({ error: reason.message }, reason.status)
      : context.json(
          { error: "Agent 操作失败，请检查运行环境与会话状态" },
          502,
        );
  const handle =
    (
      operation: (
        context: Context,
        userId: string,
      ) => unknown | Promise<unknown>,
    ) =>
    async (context: Context) => {
      const userId = currentUser(context);
      if (!userId) return context.json({ error: "请先登录" }, 401);
      if (!browserLimit.allow(userId))
        return context.json({ error: "Agent 请求过多，请稍后重试" }, 429);
      try {
        return context.json({ data: await operation(context, userId) });
      } catch (reason) {
        return error(context, reason);
      }
    };
  const callback =
    (
      operation: (
        context: Context,
        userId: string,
        id: string,
      ) => unknown | Promise<unknown>,
    ) =>
    async (context: Context) => {
      const id = context.req.param("id")!;
      const header = context.req.header("Authorization") ?? "";
      if (!/^Bearer nxa_[a-f0-9]{64}$/.test(header))
        return context.json({ error: "请提供此 Agent 的 Bearer 凭据" }, 401);
      try {
        const identity = service.authenticate(header.slice(7), id);
        if (!callbackLimit.allow(`${identity.userId}:${id}`))
          return context.json({ error: "Agent 回报请求过多" }, 429);
        const taskId = context.req.query("taskId");
        if (taskId && taskId !== identity.agent.taskId)
          return context.json({ error: "凭据不属于此任务" }, 403);
        return context.json({
          data: await operation(context, identity.userId, id),
        });
      } catch (reason) {
        if (
          reason instanceof WorkspaceError &&
          reason.message === "Agent 凭据无效或已过期"
        )
          return context.json({ error: reason.message }, 401);
        return error(context, reason);
      }
    };
  const body = async (context: Context): Promise<Record<string, unknown>> => {
    const value: unknown = await context.req.json().catch(() => null);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new WorkspaceError("请求体需要使用 JSON 对象");
    return value as Record<string, unknown>;
  };
  app.get(
    "/api/agent-providers",
    handle((_, userId) => service.providers(userId)),
  );
  app.post(
    "/api/agent-providers",
    handle(async (c, u) => service.saveProvider(u, await body(c))),
  );
  app.put(
    "/api/agent-providers/:id",
    handle(async (c, u) =>
      service.saveProvider(u, await body(c), c.req.param("id")!),
    ),
  );
  app.delete(
    "/api/agent-providers/:id",
    handle((c, u) => service.deleteProvider(u, c.req.param("id")!)),
  );
  app.get(
    "/api/tasks/:taskId/workspace-bindings",
    handle((c, u) => service.bindings(u, c.req.param("taskId")!)),
  );
  app.post(
    "/api/tasks/:taskId/workspace-bindings",
    handle(async (c, u) =>
      service.bind(u, c.req.param("taskId")!, await body(c)),
    ),
  );
  app.get(
    "/api/agents/:id/conversation",
    handle((c, u) =>
      service.snapshot(
        u,
        c.req.param("id")!,
        c.req.query("before") ? Number(c.req.query("before")) : undefined,
      ),
    ),
  );
  app.patch(
    "/api/agents/:id/messages/:messageId",
    handle(async (c, u) =>
      service.queue(
        u,
        c.req.param("id")!,
        c.req.param("messageId")!,
        await body(c),
      ),
    ),
  );
  app.post(
    "/api/agents/:id/runs/:runId/reconcile",
    handle(async (c, u) =>
      service.reconcile(
        u,
        c.req.param("id")!,
        c.req.param("runId")!,
        await body(c),
      ),
    ),
  );
  app.post(
    "/api/agents/:id/answers",
    handle(async (c, u) => {
      const b = await body(c);
      return service.answer(u, c.req.param("id")!, b.permissionId, b.answers);
    }),
  );
  app.post(
    "/api/agents/:id/terminal",
    handle(async (c, u) => {
      const input = await c.req.json().catch(() => ({}));
      return service.terminal(u, c.req.param("id")!, input.requestId);
    }),
  );
  app.delete(
    "/api/agents/:id/terminals/:paneId",
    handle((c, u) =>
      service.endTerminal(u, c.req.param("id")!, c.req.param("paneId")!),
    ),
  );
  app.get(
    "/api/agents/:id/changes",
    handle((c, u) => service.changes(u, c.req.param("id")!)),
  );
  app.get(
    "/api/agents/:id/workarea/cleanup-plan",
    handle((c, u) => service.workAreaPlan(u, c.req.param("id")!)),
  );
  app.delete(
    "/api/agents/:id/workarea",
    handle(async (c, u) =>
      service.cleanWorkArea(u, c.req.param("id")!, await body(c)),
    ),
  );
  app.get(
    "/api/agents",
    handle((_, userId) =>
      db
        .agentRecords<
          import("../../../../packages/core/src/index").WorkspaceAgent
        >(userId)
        .map((row) => service.get(userId, row.id)),
    ),
  );
  app.get(
    "/api/agent-products",
    handle(() => AGENT_PRODUCT_PRESETS),
  );
  app.post(
    "/api/agents/check",
    handle(async (context, userId) =>
      service.checkConnection(userId, await body(context)),
    ),
  );
  app.get(
    "/api/agent-workbench",
    handle((_, userId) => service.workbench(userId)),
  );
  app.get(
    "/api/tasks/:taskId/agent-prompt",
    handle((context, userId) =>
      service.prompt(
        userId,
        context.req.param("taskId")!,
        new URL(context.req.url).origin,
      ),
    ),
  );
  app.get(
    "/api/tasks/:taskId/agents",
    handle((context, userId) =>
      service.list(userId, context.req.param("taskId")!),
    ),
  );
  app.post(
    "/api/tasks/:taskId/agents",
    handle(async (context, userId) =>
      service.create(
        userId,
        context.req.param("taskId")!,
        (await body(context)) as unknown as CreateWorkspaceAgent,
        new URL(context.req.url).origin,
      ),
    ),
  );
  app.get(
    "/api/agents/:id",
    handle((context, userId) => service.get(userId, context.req.param("id")!)),
  );
  app.get(
    "/api/agents/:id/events",
    handle((context, userId) =>
      service.events(
        userId,
        context.req.param("id")!,
        Number(context.req.query("after") ?? 0),
      ),
    ),
  );
  app.get("/api/agents/:id/stream", async (context) => {
    const userId = currentUser(context),
      id = context.req.param("id")!;
    if (!userId) return context.json({ error: "请先登录" }, 401);
    if (!browserLimit.allow(userId))
      return context.json({ error: "实时连接请求过多" }, 429);
    let cursor = Number(
        context.req.header("Last-Event-ID") ?? context.req.query("after") ?? 0,
      ),
      pending = true,
      wake: (() => void) | undefined,
      closed = false;
    let unsubscribe: () => void;
    try {
      service.events(userId, id, cursor);
      unsubscribe = service.subscribe(userId, id, () => {
        pending = true;
        wake?.();
      });
    } catch (reason) {
      return error(context, reason);
    }
    context.header("X-Accel-Buffering", "no");
    return streamSSE(context, async (stream) => {
      let lastState = "";
      stream.onAbort(() => {
        closed = true;
        unsubscribe();
        wake?.();
      });
      try {
        while (
          !closed &&
          !service.isClosed() &&
          currentUser(context) === userId
        ) {
          pending = false;
          let more = true;
          while (more && !closed) {
            const page = service.events(userId, id, cursor);
            for (const event of page.events) {
              await stream.writeSSE({
                id: String(event.id),
                event: "agent-event",
                data: JSON.stringify(event),
              });
              cursor = event.id;
            }
            more = page.hasMore;
          }
          const state = JSON.stringify(service.get(userId, id));
          if (state !== lastState) {
            await stream.writeSSE({ event: "agent-state", data: state });
            lastState = state;
          }
          if (pending) continue;
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              wake = undefined;
              resolve();
            }, 15000);
            wake = () => {
              clearTimeout(timer);
              wake = undefined;
              resolve();
            };
            if (closed || pending) wake();
          });
          if (!closed && currentUser(context) === userId)
            await stream.writeSSE({ event: "ping", data: "{}" });
        }
      } finally {
        closed = true;
        wake?.();
        unsubscribe();
      }
    });
  });
  app.get(
    "/api/agents/:id/rounds",
    handle((context, userId) =>
      service.rounds(userId, context.req.param("id")!),
    ),
  );
  app.post(
    "/api/agents/:id/rounds",
    handle(async (context, userId) =>
      service.startRound(userId, context.req.param("id")!, await body(context)),
    ),
  );
  app.post(
    "/api/agents/:id/rounds/:roundId/review",
    handle(async (context, userId) =>
      service.reviewRound(
        userId,
        context.req.param("id")!,
        context.req.param("roundId")!,
        await body(context),
      ),
    ),
  );
  app.post(
    "/api/agents/:id/rounds/:roundId/cancel",
    handle(async (context, userId) =>
      service.cancelRound(
        userId,
        context.req.param("id")!,
        context.req.param("roundId")!,
        await body(context),
      ),
    ),
  );
  app.post(
    "/api/agents/:id/messages",
    handle(async (context, userId) => {
      const value = await body(context);
      return service.send(userId, context.req.param("id")!, {
        requestId: value.requestId,
        text: value.text,
      });
    }),
  );
  app.post(
    "/api/agents/:id/cancel",
    handle((context, userId) =>
      service.cancel(userId, context.req.param("id")!),
    ),
  );
  app.post(
    "/api/agents/:id/stop",
    handle((context, userId) => service.stop(userId, context.req.param("id")!)),
  );
  app.post(
    "/api/agents/:id/retry",
    handle((context, userId) =>
      service.retry(userId, context.req.param("id")!),
    ),
  );
  app.post(
    "/api/agents/:id/resume",
    handle(async (context, userId) =>
      service.resume(
        userId,
        context.req.param("id")!,
        (await body(context)).newSession === true,
      ),
    ),
  );
  app.post(
    "/api/agents/:id/permissions",
    handle(async (context, userId) => {
      const value = await body(context);
      return service.permission(
        userId,
        context.req.param("id")!,
        value.permissionId,
        value.optionId,
      );
    }),
  );
  app.get(
    "/api/agent-context/:id",
    callback((_, userId, id) => service.context(userId, id)),
  );
  app.get(
    "/api/agent-context/:id/messages",
    callback((_, userId, id) => service.unread(userId, id)),
  );
  app.post(
    "/api/agent-context/:id/messages/ack",
    callback(async (context, userId, id) =>
      service.acknowledge(userId, id, (await body(context)).messageIds),
    ),
  );
  app.post(
    "/api/agent-context/:id/reports",
    callback(async (context, userId, id) =>
      service.report(userId, id, await body(context)),
    ),
  );
  app.patch(
    "/api/agent-context/:id/description",
    callback(async (context, userId, id) =>
      service.updateDescription(userId, id, await body(context)),
    ),
  );
  app.post(
    "/api/agent-context/:id/events",
    callback(async (context, userId, id) =>
      service.callbackEvent(userId, id, await body(context)),
    ),
  );
  return service;
}
