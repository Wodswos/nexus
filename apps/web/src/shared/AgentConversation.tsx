import { useUI } from "@/state/ui";
import { commitTaskTextDrafts } from "./useTaskTextDraft";
import { useNavigate, useLocation } from "react-router";
import React, { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Bot,
  Circle,
  LoaderCircle,
  Plus,
  Terminal,
} from "lucide-react";
import { Button } from "@nexus/ui";
import { type WorkspaceConfig, type WorkspaceEnvironment } from "@nexus/core";
import { currentStore, useNexus } from "@nexus/crdt";
import { useAuth } from "@/app/auth";
import {
  agentWorkspaceApi,
  type WorkspaceAgentView,
} from "./agentWorkspaceApi";
import { WorkspaceAgentCreate } from "./WorkspaceAgentCreate";

export const agentStateLabels: Record<WorkspaceAgentView["state"], string> = {
  queued: "排队中",
  preparing: "准备 Workspace",
  starting: "启动中",
  idle: "等待指令",
  running: "进行中",
  waiting: "等待回复",
  failed: "执行失败",
  interrupted: "已中断",
  stopped: "已停止",
  disconnected: "连接断开",
};
const pendingStates = new Set(["queued", "preparing", "starting", "running"]);
function State({ agent }: { agent: WorkspaceAgentView }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-micro text-muted">
      {pendingStates.has(agent.state) ? (
        <LoaderCircle size={11} className="animate-spin" />
      ) : (
        <Circle
          size={7}
          fill="currentColor"
          className={
            agent.state === "waiting"
              ? "text-[var(--accent-solid)]"
              : "opacity-50"
          }
        />
      )}
      {agentStateLabels[agent.state]}
      {agent.mode === "tmux" && " · 终端接入"}
    </span>
  );
}
export function AgentConversation({
  taskId,
  workspaceId,
  config,
  environment,
  beforeAction,
  createdAgent,
  onCreated,
  onAgentsCount,
  onEnvironmentCreated,
  hideOverview,
  onClose,
  allowCreate = true,
}: {
  taskId: string;
  workspaceId?: string | null;
  config: WorkspaceConfig;
  environment?: WorkspaceEnvironment;
  allowCreate?: boolean;
  hideOverview?: boolean;
  onClose?: () => void;
  onEnvironmentCreated?: (environment: WorkspaceEnvironment) => void;
  beforeAction: () => Promise<void>;
  createdAgent?: WorkspaceAgentView | null;
  onCreated?: (agent: WorkspaceAgentView) => void;
  onAgentsCount?: (count: number) => void;
}) {
  const store = useNexus(),
    { user } = useAuth();
  const navigate = useNavigate(),
    location = useLocation();
  const openWorkbench = (id: string) => {
    const from = location.pathname + location.search;
    void commitTaskTextDrafts()
      .then(() => {
        if (currentStore() !== store) return;
        useUI.getState().selectTask(null);
        navigate(`/work/agents/${id}`, { state: { returnTo: from } });
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : "保存任务失败"),
      );
  };
  const [agents, setAgents] = useState<WorkspaceAgentView[]>([]);
  const [creating, setCreating] = useState(false),
    [error, setError] = useState("");
  const countCallback = useRef(onAgentsCount);
  countCallback.current = onAgentsCount;
  useEffect(() => {
    countCallback.current?.(agents.length);
  }, [agents.length]);
  const updateAgent = (agent: WorkspaceAgentView) =>
    setAgents((previous) => {
      const old = previous.find((item) => item.id === agent.id);
      if (old && old.updatedAt > agent.updatedAt) return previous;
      if (
        old?.updatedAt === agent.updatedAt &&
        old.state === agent.state &&
        old.error === agent.error &&
        JSON.stringify(old.currentRound) === JSON.stringify(agent.currentRound)
      )
        return previous;
      return old
        ? previous.map((item) => (item.id === agent.id ? agent : item))
        : [...previous, agent];
    });
  useEffect(() => {
    if (!createdAgent) return;
    updateAgent(createdAgent);
    openWorkbench(createdAgent.id);
  }, [createdAgent?.id]);
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const requestedAt = Date.now();
        const values = await agentWorkspaceApi.list(taskId);
        if (cancelled || currentStore() !== store) return;
        setAgents((previous) => {
          // A concurrent creation or event poll can be newer than this overview response.
          const merged = values.map((value) => {
            const prior = previous.find((item) => item.id === value.id);
            return prior && prior.updatedAt > value.updatedAt ? prior : value;
          });
          for (const prior of previous)
            if (
              !merged.some((value) => value.id === prior.id) &&
              prior.createdAt >= requestedAt
            )
              merged.push(prior);
          return JSON.stringify(previous) === JSON.stringify(merged)
            ? previous
            : merged;
        });
        setError("");
      } catch (reason) {
        if (!cancelled && currentStore() === store)
          setError(
            reason instanceof Error ? reason.message : "Agent 列表读取失败",
          );
      } finally {
        if (!cancelled && currentStore() === store) {
          timer = setTimeout(
            () => void refresh(),
            document.hidden ? 10000 : 3000,
          );
        }
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [taskId, user?.id, store]);
  if (!user) return null;
  const canCreate = allowCreate;
  return (
    <section aria-label="Workspace Agents" className="space-y-2">
      {!hideOverview && (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-xs font-medium">
              <Bot size={14} />
              Agents{" "}
              {agents.length > 0 && (
                <span className="text-micro font-normal text-muted">
                  {agents.length}
                </span>
              )}
            </span>
            <Button
              type="button"
              size="sm"
              variant="primary"
              disabled={!canCreate}
              onClick={() => setCreating(true)}
            >
              <Plus size={12} />
              创建 Agent
            </Button>
          </div>
          {agents.map((agent) => (
            <button
              type="button"
              key={agent.id}
              onClick={() => openWorkbench(agent.id)}
              className="flex w-full items-center gap-2.5 rounded-[var(--radius-md)] px-2 py-2 hover:bg-[var(--surface)] text-left transition-colors hover:border-[var(--border-strong)]"
            >
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[var(--radius-md)] bg-[var(--surface-raised)] text-muted">
                {agent.mode === "tmux" ? (
                  <Terminal size={15} />
                ) : (
                  <Bot size={15} />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">
                  {agent.name}
                </span>
                <State agent={agent} />
              </span>
              <ArrowUpRight size={13} className="text-muted" />
            </button>
          ))}
          {error && (
            <p role="alert" className="text-micro text-[var(--danger)]">
              {error}
            </p>
          )}
        </>
      )}
      {creating && (
        <WorkspaceAgentCreate
          taskId={taskId}
          workspaceId={workspaceId}
          config={config}
          environment={environment}
          beforeAction={beforeAction}
          onClose={() => {
            setCreating(false);
            onClose?.();
          }}
          onCreated={(createdEnvironment, agent) => {
            setCreating(false);
            onEnvironmentCreated?.(createdEnvironment);
            if (agent) {
              updateAgent(agent);
              openWorkbench(agent.id);
              onCreated?.(agent);
            }
          }}
        />
      )}
    </section>
  );
}
