import { SelectField } from "@nexus/ui";
import React, { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Search,
  Settings2,
} from "lucide-react";
import { useNexus, useNexusData, currentStore } from "@nexus/crdt";
import {
  agentWorkspaceApi,
  type WorkspaceAgentView,
} from "@/shared/agentWorkspaceApi";
import { agentStateLabels } from "@/shared/AgentConversation";
const groupNames = {
  waiting: "等我回应",
  review: "待验收",
  running: "执行中",
  error: "异常",
  recent: "最近",
};
export function AgentSidebar() {
  const store = useNexus(),
    data = useNexusData(),
    location = useLocation();
  const [agents, setAgents] = useState<WorkspaceAgentView[]>([]),
    [project, setProject] = useState(""),
    [query, setQuery] = useState(""),
    [error, setError] = useState("");
  const [collapsed, setCollapsed] = useState<string[]>(() => {
    try {
      return JSON.parse(
        localStorage.getItem(`nexus:agent-groups:${store.userId}`) || "[]",
      );
    } catch {
      return [];
    }
  });
  useEffect(() => {
    let ended = false,
      timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await agentWorkspaceApi.all();
        if (!ended && currentStore() === store) {
          setAgents((old) =>
            JSON.stringify(old) === JSON.stringify(next) ? old : next,
          );
          setError("");
        }
      } catch (e) {
        if (!ended) setError(e instanceof Error ? e.message : "读取失败");
      } finally {
        if (!ended) timer = setTimeout(refresh, document.hidden ? 15000 : 4000);
      }
    };
    void refresh();
    return () => {
      ended = true;
      clearTimeout(timer);
    };
  }, [store]);
  const grouped = useMemo(() => {
    const result: Record<keyof typeof groupNames, WorkspaceAgentView[]> = {
      waiting: [],
      review: [],
      running: [],
      error: [],
      recent: [],
    };
    for (const agent of [...agents].sort((a, b) => b.createdAt - a.createdAt)) {
      const task = data.tasks.find((t) => t.id === agent.taskId);
      if (project) {
        let node = task;
        const seen = new Set<string>();
        while (node && !node.project && !seen.has(node.id)) {
          seen.add(node.id);
          node = data.tasks.find((t) => t.id === node!.parentId);
        }
        if (node?.id !== project) continue;
      }
      if (
        query &&
        !`${task?.title} ${agent.name}`
          .toLowerCase()
          .includes(query.toLowerCase())
      )
        continue;
      const group =
        agent.state === "waiting"
          ? "waiting"
          : agent.currentRound?.state === "awaiting_review"
            ? "review"
            : ["queued", "preparing", "starting", "running"].includes(
                  agent.state,
                )
              ? "running"
              : ["failed", "disconnected"].includes(agent.state)
                ? "error"
                : "recent";
      result[group].push(agent);
    }
    return result;
  }, [agents, query, project, data.tasks]);
  return (
    <section aria-label="Agent 导航" className="agent-navigation">
      <label className="agent-search">
        <Search size={14} />
        <input
          aria-label="搜索 Agent"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索 Agent…"
        />
      </label>
      <SelectField
        aria-label="Agent 项目筛选"
        className="mb-2 w-full"
        value={project}
        onValueChange={setProject}
        options={[
          { value: "", label: "全部项目" },
          ...data.tasks
            .filter((t) => t.project && !t.deletedAt)
            .map((t) => ({ value: t.id, label: t.title })),
        ]}
      />
      {error && (
        <p role="alert" className="p-2 text-xs text-[var(--danger)]">
          {error}
        </p>
      )}
      {Object.entries(groupNames).map(([key, label]) => {
        const rows = grouped[key as keyof typeof grouped];
        if (!rows.length) return null;
        const closed = collapsed.includes(key);
        return (
          <section key={key}>
            <button
              className="agent-group"
              aria-expanded={!closed}
              onClick={() =>
                setCollapsed((old) => {
                  const next = closed
                    ? old.filter((v) => v !== key)
                    : [...old, key];
                  try {
                    localStorage.setItem(
                      `nexus:agent-groups:${store.userId}`,
                      JSON.stringify(next),
                    );
                  } catch {}
                  return next;
                })
              }
            >
              {closed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
              <span>{label}</span>
              <span className="ml-auto">{rows.length}</span>
            </button>
            {!closed &&
              rows.map((agent) => {
                const task = data.tasks.find((row) => row.id === agent.taskId);
                return (
                  <Link
                    key={agent.id}
                    to={`/work/agents/${agent.id}`}
                    className="agent-nav-row"
                    aria-current={
                      location.pathname.endsWith("/" + agent.id)
                        ? "page"
                        : undefined
                    }
                  >
                    <Bot size={15} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">
                        {task?.title || agent.name}
                      </span>
                      <span className="block truncate text-[11px] text-muted">
                        {agent.name} · {agentStateLabels[agent.state]}
                      </span>
                    </span>
                  </Link>
                );
              })}
          </section>
        );
      })}
      {!agents.length && !error && (
        <p className="p-3 text-xs leading-6 text-muted">
          从 Task 创建 Agent，工作会话会显示在这里。
        </p>
      )}
      <Link to="/workspaces" className="agent-nav-row mt-3">
        <Settings2 size={14} />
        Workspace 与 Provider
      </Link>
    </section>
  );
}
