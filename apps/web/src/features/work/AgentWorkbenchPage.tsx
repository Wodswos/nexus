import React, { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { ArrowUpRight, Bot, RefreshCw, Settings2 } from "lucide-react";
import { savedViewHref, WEEK_WORK_VIEW } from "@nexus/core";
import { currentStore, useNexus, useNexusData } from "@nexus/crdt";
import {
  agentWorkspaceApi,
  type AgentWorkbench,
} from "@/shared/agentWorkspaceApi";
import { useAuth } from "@/app/auth";
import { agentStateLabels } from "@/shared/AgentConversation";

import { AgentThread } from "./AgentThread";
import { useTaskHref } from "./useTaskHref";

const groups = [
  { key: "waiting", label: "等我回复", description: "回复问题或确认工具权限" },
  { key: "review", label: "待验收", description: "核对本轮产物与验收条件" },
  { key: "running", label: "执行中", description: "正在准备或推进的工作" },
  { key: "error", label: "异常", description: "需要检查连接或恢复执行" },
] as const;
export default function AgentWorkbenchPage() {
  const { id } = useParams(),
    store = useNexus();
  return id ? (
    <AgentThread key={`${store.userId}:${id}`} id={id} />
  ) : (
    <Overview key={store.userId} />
  );
}
function Overview() {
  const store = useNexus(),
    data = useNexusData(),
    { user } = useAuth();
  const [work, setWork] = useState<AgentWorkbench | null>(null),
    [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const taskHref = useTaskHref();
  useEffect(() => {
    if (!user) {
      setWork({
        groups: { waiting: [], review: [], running: [], error: [] },
        counts: {},
      });
      return;
    }
    let cancelled = false,
      timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await agentWorkspaceApi.workbench();
        if (!cancelled && currentStore() === store) {
          setWork((old) =>
            JSON.stringify(old) === JSON.stringify(next) ? old : next,
          );
          setError("");
        }
      } catch (reason) {
        if (!cancelled && currentStore() === store)
          setError(reason instanceof Error ? reason.message : "读取失败");
      } finally {
        if (!cancelled && currentStore() === store)
          timer = setTimeout(
            () => void refresh(),
            document.hidden ? 10000 : 3000,
          );
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [store, user?.id, refreshKey]);
  const count = groups.reduce(
    (sum, group) => sum + (work?.groups[group.key]?.length ?? 0),
    0,
  );
  return (
    <main
      aria-label="当前工作看板"
      className="mx-auto flex h-full w-full max-w-6xl flex-col overflow-y-auto px-5 py-6 sm:px-8"
    >
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">当前工作</h1>
          <p className="mt-1 text-xs leading-6 text-muted">
            跨项目查看 Agent 进展，优先处理需要你回应和验收的工作。
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            aria-label="刷新当前工作"
            onClick={() => setRefreshKey((key) => key + 1)}
            className="p-2 text-muted"
          >
            <RefreshCw size={15} />
          </button>
          <Link
            to="/workspaces"
            className="flex items-center gap-1.5 text-xs text-muted"
          >
            <Settings2 size={14} />
            Workspace 模板
          </Link>
        </div>
      </header>
      {error && (
        <p role="alert" className="mb-4 text-xs text-[var(--danger)]">
          {error}
        </p>
      )}
      {!work && !error && (
        <p role="status" className="py-16 text-center text-xs text-muted">
          正在读取工作进展…
        </p>
      )}
      {work && count === 0 && (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 pb-20 text-center">
          <Bot size={32} strokeWidth={1.2} className="text-muted" />
          <p className="text-sm">
            {user ? "暂时没有需要关注的 Agent 工作" : "登录后可管理 Agent 工作"}
          </p>
          <p className="max-w-sm text-xs leading-6 text-muted">
            在任意任务中新建
            Agent，即可从这里继续对话、查看进展和验收本轮结果。手动推进的任务仍在项目和本周工作中。
          </p>
          <Link
            to={savedViewHref(
              data.settings.savedViews.find(
                (view) => view.id === WEEK_WORK_VIEW.id,
              ) ?? WEEK_WORK_VIEW,
            )}
            className="text-xs underline underline-offset-4"
          >
            查看本周任务
          </Link>
        </div>
      )}
      {work && count > 0 && (
        <div className="grid gap-6 lg:grid-cols-2">
          {groups.map((group) => (
            <section
              key={group.key}
              aria-label={group.label}
              className="min-w-0"
            >
              <header className="mb-3 flex items-center gap-2">
                <h2 className="text-sm font-medium">{group.label}</h2>
                <span className="text-xs text-muted">
                  {work.groups[group.key]?.length ?? 0}
                </span>
              </header>
              <div className="space-y-2">
                {work.groups[group.key]?.map((row) => (
                  <article
                    aria-label={row.task.title}
                    key={row.task.id}
                    className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-4"
                  >
                    <div className="flex items-start gap-2">
                      {taskHref(row.task.id) ? (
                        <Link
                          to={taskHref(row.task.id)!}
                          aria-label={`打开 Task：${row.task.title}`}
                          className="flex min-w-0 flex-1 items-start gap-2 text-sm font-medium hover:underline"
                        >
                          <span className="min-w-0 flex-1 break-words">
                            {row.task.title}
                          </span>
                          <span className="mt-0.5 flex shrink-0 items-center gap-1 text-micro font-normal text-muted">
                            打开 Task
                            <ArrowUpRight size={13} />
                          </span>
                        </Link>
                      ) : (
                        <span className="text-sm font-medium">
                          {row.task.title}
                        </span>
                      )}
                    </div>
                    {row.projectTitle && (
                      <p className="mt-1 text-micro text-muted">
                        {row.projectTitle}
                      </p>
                    )}
                    {row.reasons.length > 0 && (
                      <p className="mt-2 text-xs leading-6 text-muted">
                        {row.reasons.join(" · ")}
                      </p>
                    )}
                    <div className="mt-3 space-y-1">
                      {row.agents.map((agent) => (
                        <Link
                          key={agent.id}
                          to={`/work/agents/${encodeURIComponent(agent.id)}`}
                          state={{ returnTo: "/work" }}
                          className="flex w-full items-center gap-2 rounded-[var(--radius-md)] px-2 py-2 text-left hover:bg-[var(--surface-raised)]"
                        >
                          <Bot size={13} className="shrink-0 text-muted" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs">
                              {agent.currentRound?.objective || agent.name}
                            </span>
                            <span className="text-micro text-muted">
                              {agent.name} · {agentStateLabels[agent.state]}
                            </span>
                          </span>
                          <ArrowUpRight size={12} className="text-muted" />
                        </Link>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
              {!work.groups[group.key]?.length && (
                <p className="rounded-[var(--radius-lg)] border border-dashed border-[var(--border)] px-4 py-6 text-xs text-muted">
                  {group.description} · 暂无
                </p>
              )}
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
