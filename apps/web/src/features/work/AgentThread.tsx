import React, {
  lazy,
  Suspense,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Link, useLocation } from "react-router";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  Maximize2,
  PanelRight,
  Square,
  Terminal,
  X,
} from "lucide-react";
import { Button } from "@nexus/ui";
import { copyText } from "@/shared/copyText";
import { ChangePreview } from "./ChangePreview";
import { WorkAreaCleanup } from "./WorkAreaCleanup";
import { AgentReferences } from "./AgentReferences";
import {
  newUuid,
  type AgentEvent,
  type AgentQuestion,
  type ConversationItem,
  type ConversationSnapshot,
  type WorkspacePane,
} from "@nexus/core";
import {
  api,
  apiUrl,
  apiSupportsBrowserStreaming,
  currentStore,
  useNexus,
  useNexusData,
} from "@nexus/crdt";
import {
  agentWorkspaceApi,
  type WorkspaceAgentView,
} from "@/shared/agentWorkspaceApi";
import { agentStateLabels } from "@/shared/AgentConversation";
import { MarkdownDocument } from "@/shared/MarkdownDocument";
import { TaskDescription } from "@/shared/TaskDescription";
import { useTaskTextDraft } from "@/shared/useTaskTextDraft";
import { AgentQuestionForm } from "./AgentQuestionForm";
import { AgentSuggestions } from "./AgentSuggestions";
import { agentDiagnostic } from "./agentDiagnostics";
import { applyConversationEvent } from "./conversation";
import { useTaskHref } from "./useTaskHref";
import {
  cacheConversation,
  readConversationCache,
  clearConversationCache,
} from "./conversationCache";
const WorkspaceTerminal = lazy(() => import("@/shared/WorkspaceTerminal"));
const read = (key: string, fallback = "") => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};
const save = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {}
};

const Item = memo(function Item({
  item,
  answer,
  busy,
  legacyTerminal = false,
  requestControls = false,
}: {
  item: ConversationItem;
  answer: (
    id: string,
    option: string | null,
    answers?: Record<string, string | string[]>,
  ) => void;
  busy: boolean;
  legacyTerminal?: boolean;
  requestControls?: boolean;
}) {
  const [expanded, setExpanded] = useState(false),
    [logLimit, setLogLimit] = useState(12000);
  const [copyState, setCopyState] = useState("");
  const data = item.data ?? {};
  const diagnostic =
    item.kind === "terminal" || item.kind === "error"
      ? agentDiagnostic(item.text)
      : undefined;
  if (item.kind === "terminal")
    return (
      <details className="agent-tool">
        <summary>
          {legacyTerminal
            ? "最近保存的终端快照（非完整对话）"
            : diagnostic!.title}
        </summary>
        {!legacyTerminal && diagnostic!.hint && (
          <p className="px-3 py-2 text-xs leading-5 text-muted">
            {diagnostic!.hint}
          </p>
        )}
        <pre>{diagnostic!.log}</pre>
      </details>
    );
  if (item.kind === "tool") {
    const input = JSON.stringify(
      data.rawInput ?? data.command ?? data.input ?? data.changes ?? {},
      null,
      2,
    );
    const output =
      typeof data.aggregatedOutput === "string"
        ? data.aggregatedOutput
        : typeof data.rawOutput === "string"
          ? data.rawOutput
          : JSON.stringify(data.rawOutput ?? data.content ?? "", null, 2);
    return (
      <details
        className="agent-tool"
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary>
          <span className="inline-block w-4">
            {data.status === "completed" ? (
              <Check size={12} />
            ) : data.status === "failed" ? (
              "!"
            ) : (
              "·"
            )}
          </span>
          <span className="truncate">{item.text}</span>
          <span className="ml-auto text-xs text-muted">
            {(
              {
                completed: "已完成",
                failed: "失败",
                in_progress: "执行中",
                pending: "待执行",
                cancelled: "已取消",
              } as Record<string, string>
            )[String(data.status)] ?? String(data.status ?? "")}
          </span>
        </summary>
        {expanded && (
          <>
            <pre>{input.slice(0, logLimit)}</pre>
            <pre>{output.slice(0, logLimit)}</pre>
            {Math.max(input.length, output.length) > logLimit && (
              <button
                className="mb-2 text-xs underline"
                onClick={() => setLogLimit((n) => n + 24000)}
              >
                显示更多日志
              </button>
            )}
            <button
              className="mb-2 ml-3 text-xs underline"
              onClick={() => {
                const url = URL.createObjectURL(
                  new Blob([input + "\n" + output], {
                    type: "text/plain;charset=utf-8",
                  }),
                );
                const a = document.createElement("a");
                a.href = url;
                a.download = "agent-tool-log.txt";
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              }}
            >
              下载完整已保存日志
            </button>
          </>
        )}
      </details>
    );
  }
  if (item.kind === "permission") {
    const questions = Array.isArray(data.questions)
      ? (data.questions as AgentQuestion[])
      : [];
    return (
      <section className="agent-request" aria-label="Agent 待处理请求">
        <p className="mb-2 text-sm font-medium">{item.text}</p>
        {data.resolved ? (
          <div className="space-y-1 text-xs text-muted">
            {questions.map((q) => (
              <p key={q.id}>
                {q.question}：
                {(
                  data.answers as
                    | Record<string, { answers?: string[] }>
                    | undefined
                )?.[q.id]?.answers?.join("；") ||
                  (typeof data.freeform === "string"
                    ? data.freeform
                    : "已处理")}
              </p>
            ))}
            {!questions.length && "已处理"}
          </div>
        ) : questions.length ? (
          requestControls ? (
            <AgentQuestionForm
              questions={questions}
              busy={busy}
              onAnswer={(answers) =>
                answer(String(data.permissionId), null, answers)
              }
            />
          ) : (
            <p className="text-xs text-muted">请在输入框上方回答问题。</p>
          )
        ) : (
          <>
            <details className="mb-2 text-xs">
              <summary>查看请求内容</summary>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap">
                {JSON.stringify(data.toolCall, null, 2)}
              </pre>
            </details>
            <div className="flex flex-wrap gap-2">
              {(Array.isArray(data.options) ? data.options : []).map(
                (o: any) => (
                  <Button
                    key={o.optionId}
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      answer(String(data.permissionId), o.optionId)
                    }
                  >
                    {o.name}
                  </Button>
                ),
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => answer(String(data.permissionId), null)}
              >
                拒绝
              </Button>
            </div>
          </>
        )}
      </section>
    );
  }
  if (item.kind === "thought" || item.kind === "plan")
    return (
      <details className="agent-tool">
        <summary>{item.kind === "thought" ? "进展摘要" : "工作计划"}</summary>
        <MarkdownDocument text={item.text} />
      </details>
    );
  if (item.kind === "status") return null;
  if (item.kind === "error")
    return diagnostic!.hint ? (
      <div className="space-y-1">
        <p className="text-sm text-[var(--danger)]">{diagnostic!.title}</p>
        <p className="text-xs leading-5 text-muted">{diagnostic!.hint}</p>
        <details className="agent-tool">
          <summary>查看原始错误</summary>
          <pre>{diagnostic!.log}</pre>
        </details>
      </div>
    ) : (
      <p className="text-sm text-[var(--danger)]">{diagnostic!.log}</p>
    );
  const text = <MarkdownDocument text={item.text} />;
  return (
    <article
      className={
        item.kind === "user" ? "agent-user-message" : "agent-assistant-message"
      }
    >
      {item.kind === "user" && item.text.length > 1800 ? (
        <details>
          <summary>查看完整指令</summary>
          {text}
        </details>
      ) : (
        text
      )}
      {item.kind === "report" && (
        <section className="mt-3 space-y-2 rounded-lg border border-[var(--border)] p-3 text-xs">
          <p className="text-muted">本轮报告</p>
          {typeof data.verification === "string" && (
            <p>验证：{data.verification}</p>
          )}
          {typeof data.remaining === "string" && <p>剩余：{data.remaining}</p>}
          {Array.isArray(data.artifacts) &&
            data.artifacts
              .filter(
                (v): v is string =>
                  typeof v === "string" && /^https?:\/\//.test(v),
              )
              .map((url) => (
                <a
                  className="block truncate underline"
                  key={url}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {url}
                </a>
              ))}
        </section>
      )}
      <div className="agent-message-meta">
        <time dateTime={new Date(item.createdAt).toISOString()}>
          {new Date(item.createdAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </time>
        {item.kind === "user" && (
          <span>
            {
              {
                queued: "排队中",
                sending: "发送中",
                delivered: "已接收",
                unknown: "投递待核对",
                failed: "发送失败",
                cancelled: "已取消",
              }[String(data.state) as "queued"]
            }
          </span>
        )}
        <button
          aria-label="复制消息"
          onClick={() =>
            void copyText(item.text)
              .then(() => setCopyState("已复制"))
              .catch((error) => setCopyState(error.message))
          }
        >
          <Copy size={12} />
          {copyState && <span role="status">{copyState}</span>}
        </button>
      </div>
    </article>
  );
});

export function AgentThread({ id }: { id: string }) {
  const store = useNexus(),
    data = useNexusData(),
    location = useLocation(),
    prefix = `nexus:agent:${store.userId}:${id}`;
  const [cached] = useState(() => readConversationCache(store.userId, id));
  const [agent, setAgent] = useState<WorkspaceAgentView | undefined>(
      cached?.agent,
    ),
    [snapshot, setSnapshot] = useState<ConversationSnapshot | undefined>(
      cached?.snapshot,
    ),
    [items, setItems] = useState<ConversationItem[]>(
      cached?.snapshot.items ?? [],
    );
  const [offline, setOffline] = useState(!navigator.onLine);
  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  useEffect(() => {
    if (!agent || !snapshot || offline) return;
    const timer = setTimeout(
      () => cacheConversation(store.userId, agent, snapshot, items),
      800,
    );
    return () => clearTimeout(timer);
  }, [agent, snapshot, items, offline, store]);
  const [draft, setDraft] = useState(() => read(prefix + ":draft")),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [connected, setConnected] = useState(false),
    [pendingNew, setPendingNew] = useState(false);
  const [panel, setPanel] = useState<"" | "task" | "changes" | "workspace">(""),
    [changes, setChanges] = useState<{
      text: string;
      updatedAt: number;
      truncated: boolean;
    }>();
  const [environment, setEnvironment] =
    useState<import("@nexus/core").WorkspaceEnvironment>();
  const terminalRequest = useRef<string>();
  const dataUnavailable = !!(
    environment?.dataDeletedAt ||
    environment?.dataClearedAt ||
    agent?.workArea?.dataDeletedAt ||
    agent?.workArea?.cleanupStartedAt
  );
  useEffect(() => {
    if (!agent) return;
    let ended = false;
    void api
      .workspaceEnvironment(agent.environmentId)
      .then((result) => {
        if (!ended && currentStore() === store) setEnvironment(result.data);
      })
      .catch(() => {});
    return () => {
      ended = true;
    };
  }, [agent?.environmentId, store]);
  const [terminal, setTerminal] = useState<WorkspacePane>(),
    [terminalOpen, setTerminalOpen] = useState(false),
    [fullscreen, setFullscreen] = useState(false);
  const conversationOffset = useRef(0);
  const composer = useRef<HTMLTextAreaElement>(null);
  const closeTerminal = () => {
    setTerminalOpen(false);
    setFullscreen(false);
    save(prefix + ":terminal-open", "0");
  };
  const panelKey = `nexus:agent-panel:${store.userId}`;
  const [panelWidth, setPanelWidth] = useState(() =>
    Math.max(300, Math.min(480, Number(read(panelKey, "360")) || 360)),
  );
  const actionVersion = useRef(0),
    terminalRestored = useRef(false);
  const [queueOpen, setQueueOpen] = useState(false),
    [olderLoading, setOlderLoading] = useState(false);
  const scroll = useRef<HTMLDivElement>(null),
    follow = useRef(true),
    composing = useRef(false),
    mounted = useRef(true),
    request = useRef<{ id: string; text: string }>(),
    cursor = useRef(0);
  const task = data.tasks.find((t) => t.id === agent?.taskId);
  const taskHref = useTaskHref();
  const taskLink = task ? taskHref(task.id) : null;
  const taskDraft = useTaskTextDraft(task ?? null);
  const active = () => mounted.current && currentStore() === store;
  const returnTo = (location.state as { returnTo?: string } | null)?.returnTo;
  const back =
    returnTo && /^\/(?:tasks|inbox|calendar|work)(?:\?|$)/.test(returnTo)
      ? returnTo
      : (taskLink ?? "/work");
  const backLabel = back === "/work" ? "返回当前工作" : "返回任务视图";
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let disposed = false,
      source: EventSource | undefined,
      timer: ReturnType<typeof setTimeout>,
      flushTimer: ReturnType<typeof setTimeout> | undefined,
      buffer: AgentEvent[] = [];
    const current = () => !disposed && currentStore() === store;
    const flush = () => {
      flushTimer = undefined;
      if (!current()) return;
      const batch = buffer;
      buffer = [];
      setItems((old) => batch.reduce(applyConversationEvent, old));
      if (!follow.current && batch.some((event) => event.kind !== "status"))
        setPendingNew(true);
    };
    const receive = (event: AgentEvent) => {
      if (event.id <= cursor.current) return;
      cursor.current = event.id;
      if (event.kind === "status" && typeof event.data?.messageId !== "string")
        return;
      buffer.push(event);
      if (!flushTimer) flushTimer = setTimeout(flush, 40);
    };
    const poll = async () => {
      const version = actionVersion.current;
      try {
        const [next, page] = await Promise.all([
          agentWorkspaceApi.agent(id),
          agentWorkspaceApi.events(id, cursor.current),
        ]);
        if (current()) {
          if (version === actionVersion.current)
            setAgent((old) =>
              old && old.updatedAt > next.updatedAt ? old : next,
            );
          page.events.forEach(receive);
          setError("");
          if (page.hasMore) {
            timer = setTimeout(poll, 0);
            return;
          }
        }
      } catch (e) {
        if (current()) {
          if (e instanceof Error && e.message.includes("游标已过期")) {
            const page = await agentWorkspaceApi.snapshot(id);
            if (current()) {
              cursor.current = page.sequence;
              setSnapshot(page);
              setItems(page.items);
              source?.close();
            }
          } else setError(e instanceof Error ? e.message : "读取失败");
        }
      }
      if (current())
        timer = setTimeout(poll, source?.readyState === 1 ? 5000 : 2000);
    };
    const initialize = () => {
      void Promise.all([
        agentWorkspaceApi.agent(id),
        agentWorkspaceApi.snapshot(id),
      ])
        .then(([next, page]) => {
          if (!current()) return;
          setAgent(next);
          setSnapshot(page);
          setItems(page.items);
          cursor.current = page.sequence;
          cacheConversation(store.userId, next, page, page.items);
          setError("");
          setConnected(true);
          requestAnimationFrame(() => {
            const element = scroll.current;
            if (!element) return;
            const saved = read(prefix + ":anchor");
            const target = saved
              ? element.querySelector(
                  `[data-message-id="${CSS.escape(saved)}"]`,
                )
              : null;
            if (target) {
              target.scrollIntoView({ block: "start" });
              follow.current = false;
            } else element.scrollTop = element.scrollHeight;
          });
          if (apiSupportsBrowserStreaming()) {
            source = new EventSource(
              apiUrl(
                `/api/agents/${encodeURIComponent(id)}/stream?after=${page.sequence}`,
              ),
              { withCredentials: true },
            );
            source.addEventListener("agent-event", (e) => {
              if (current()) receive(JSON.parse((e as MessageEvent).data));
            });
            source.addEventListener("agent-state", (e) => {
              if (current()) {
                const next = JSON.parse((e as MessageEvent).data);
                setAgent((old) =>
                  old && old.updatedAt > next.updatedAt ? old : next,
                );
              }
            });
            source.onopen = () => {
              if (current()) setConnected(true);
            };
            source.onerror = () => {
              if (current()) setConnected(false);
            };
          }
          void poll();
        })
        .catch((e) => {
          if (current()) {
            setError(
              navigator.onLine ? e.message : "离线 · 显示最近缓存，草稿会保留",
            );
            setConnected(false);
            if ([401, 403, 404].includes(e.status)) {
              clearConversationCache(store.userId, id);
              setAgent(undefined);
              setSnapshot(undefined);
              setItems([]);
              return;
            }
            timer = setTimeout(initialize, 3000);
          }
        });
    };
    initialize();
    return () => {
      disposed = true;
      source?.close();
      clearTimeout(timer);
      clearTimeout(flushTimer);
    };
  }, [id, store]);
  useLayoutEffect(() => {
    if (!terminalOpen && follow.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [items, terminalOpen]);
  useLayoutEffect(() => {
    if (!terminalOpen && scroll.current && !follow.current)
      scroll.current.scrollTop = conversationOffset.current;
  }, [terminalOpen]);
  const act = async (work: () => Promise<unknown>) => {
    if (busy) return;
    if (!navigator.onLine) {
      setError("离线时只能阅读缓存和编辑草稿；连接恢复后再操作");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await work();
      actionVersion.current++;
      if (active()) {
        const [next, page] = await Promise.all([
          agentWorkspaceApi.agent(id),
          agentWorkspaceApi.snapshot(id),
        ]);
        if (active()) {
          setAgent(next);
          setSnapshot(page);
        }
      }
    } catch (e) {
      if (active()) setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      if (active()) setBusy(false);
    }
  };
  const send = () =>
    act(async () => {
      if (!draft.trim() || !navigator.onLine) return;
      const value = draft;
      if (request.current?.text !== value)
        request.current = { id: newUuid(), text: value };
      await store.flushPersistence();
      await agentWorkspaceApi.send(id, request.current.id, value);
      if (active()) {
        setDraft("");
        save(prefix + ":draft", "");
        request.current = undefined;
        follow.current = true;
      }
    });
  const answerImpl = (
    permissionId: string,
    optionId: string | null,
    answers?: Record<string, string | string[]>,
  ) =>
    void act(async () => {
      if (answers) await agentWorkspaceApi.answer(id, permissionId, answers);
      else await agentWorkspaceApi.permission(id, permissionId, optionId);
      if (active())
        setItems((old) =>
          old.map((item) =>
            item.data?.permissionId === permissionId
              ? { ...item, data: { ...item.data, resolved: true } }
              : item,
          ),
        );
    });
  const answerRef = useRef(answerImpl);
  answerRef.current = answerImpl;
  const answer = useCallback(
    (
      id: string,
      option: string | null,
      answers?: Record<string, string | string[]>,
    ) => answerRef.current(id, option, answers),
    [],
  );
  const older = async () => {
    if (!snapshot?.before || olderLoading) return;
    setOlderLoading(true);
    const element = scroll.current,
      height = element?.scrollHeight ?? 0;
    try {
      const page = await agentWorkspaceApi.snapshot(id, snapshot.before);
      if (active()) {
        setSnapshot((old) => ({
          ...page,
          runs: old?.runs ?? page.runs,
          messages: old?.messages ?? page.messages,
        }));
        setItems((old) => [
          ...page.items.filter(
            (item) => !old.some((value) => value.id === item.id),
          ),
          ...old,
        ]);
        requestAnimationFrame(() => {
          if (element) element.scrollTop += element.scrollHeight - height;
        });
      }
    } catch (e) {
      if (active()) setError(e instanceof Error ? e.message : "历史读取失败");
    } finally {
      if (active()) setOlderLoading(false);
    }
  };
  const openTerminal = () =>
    void act(async () => {
      const pane = terminal ?? (await agentWorkspaceApi.terminal(id));
      if (active()) {
        conversationOffset.current = scroll.current?.scrollTop ?? 0;
        setTerminal(pane);
        setTerminalOpen(true);
        save(prefix + ":terminal-open", "1");
      }
    });
  useEffect(() => {
    if (!agent || terminalRestored.current) return;
    terminalRestored.current = true;
    if (read(prefix + ":terminal-open") === "1" && agent.terminalPane) {
      setTerminal(agent.terminalPane);
      setTerminalOpen(true);
    }
  }, [agent, prefix]);
  const openChanges = () => {
    setPanel("changes");
    void act(async () => {
      const value = await agentWorkspaceApi.changes(id);
      if (active()) setChanges(value);
    });
  };
  const uncertain = (snapshot?.runs ?? []).filter(
    (run) => run.state === "unknown",
  );
  const pending = items.filter(
      (item) => item.kind === "permission" && !item.data?.resolved,
    ),
    queued = items.filter(
      (item) => item.kind === "user" && item.data?.state === "queued",
    );
  const canSend =
    agent &&
    !dataUnavailable &&
    !["failed", "disconnected", "stopped"].includes(agent.state);
  const latestTerminal =
    agent?.mode === "tmux"
      ? [...items].reverse().find((item) => item.kind === "terminal")?.id
      : undefined;
  const visibleItems = items.filter(
    (item) =>
      item.kind !== "status" &&
      (agent?.mode !== "tmux" ||
        item.kind !== "terminal" ||
        item.id === latestTerminal),
  );
  if (!agent)
    return (
      <main className="agent-shell p-6">
        <p role={error ? "alert" : "status"}>{error || "正在打开会话…"}</p>
        <Link to="/work" className="mt-4 inline-block underline">
          返回当前工作
        </Link>
      </main>
    );
  return (
    <main
      className="agent-shell flex h-full min-w-0 flex-col"
      aria-label="Agent 工作台"
    >
      <header className="agent-topbar">
        <Link to={back} title={backLabel} aria-label={backLabel}>
          <ArrowLeft size={16} />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-medium">
            {taskLink ? (
              <Link
                to={taskLink}
                aria-label={`打开 Task：${task!.title}`}
                className="flex min-w-0 items-center gap-2 hover:underline"
              >
                <span className="truncate">{task!.title}</span>
                <span className="shrink-0 text-[11px] font-normal text-muted">
                  打开 Task ↗
                </span>
              </Link>
            ) : (
              task?.title || agent.name
            )}
          </h1>
          <p className="truncate text-[11px] text-muted">
            {agent.name}
            {agent.mode === "tmux" ? " · 终端接入" : ""}
          </p>
        </div>
        <span className="hidden text-xs text-muted sm:block">
          {agentStateLabels[agent.state]}
          {!connected ? " · 正在重连" : ""}
        </span>
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={!terminalOpen}
          onClick={closeTerminal}
        >
          对话
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={terminalOpen}
          aria-label="打开终端"
          disabled={
            busy || dataUnavailable || agent.terminalPolicy === "disabled"
          }
          onClick={openTerminal}
        >
          <Terminal size={15} />
          <span className="hidden sm:inline">终端</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label="查看详情"
          onClick={() => setPanel(panel ? "" : "task")}
        >
          <PanelRight size={15} />
        </Button>
      </header>
      {agent.mode === "tmux" && !terminalOpen && (
        <aside
          aria-label="终端接入说明"
          className="flex shrink-0 items-center gap-3 border-b border-[var(--border)] px-5 py-3 text-xs leading-5 text-muted"
        >
          <p className="min-w-0 flex-1">
            此 Agent 通过 tmux
            接入。这里显示已保存的指令和工作记录；旧版未采集结构化回复，完整 CLI
            会话请在原终端查看。
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={
              busy || dataUnavailable || agent.terminalPolicy === "disabled"
            }
            onClick={openTerminal}
          >
            查看原终端
          </Button>
        </aside>
      )}
      <div className={terminalOpen ? "hidden" : "flex min-h-0 flex-1"}>
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <div
            ref={scroll}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
            aria-label="Agent 对话记录"
            onScroll={() => {
              const element = scroll.current!;
              follow.current =
                element.scrollHeight -
                  element.scrollTop -
                  element.clientHeight <
                64;
              if (follow.current) {
                setPendingNew(false);
                save(prefix + ":anchor", "");
              } else {
                const anchor = [
                  ...element.querySelectorAll<HTMLElement>("[data-message-id]"),
                ].find(
                  (row) =>
                    row.getBoundingClientRect().bottom >
                    element.getBoundingClientRect().top,
                );
                if (anchor) save(prefix + ":anchor", anchor.dataset.messageId!);
              }
            }}
          >
            <div className="agent-reading space-y-5 py-6">
              {snapshot?.hasMore && (
                <button
                  disabled={olderLoading}
                  className="mx-auto block text-xs text-muted"
                  onClick={() => void older()}
                >
                  {olderLoading ? "正在读取…" : "加载更早的消息"}
                </button>
              )}
              {agent.stage !== "ready" && (
                <p role="status" className="text-xs text-muted">
                  {
                    {
                      environment: "准备 Workspace",
                      agent: "启动 Agent 会话",
                      prompt: "发送初始指令",
                    }[agent.stage]
                  }
                </p>
              )}
              {visibleItems.map((item) => (
                <div key={item.id} data-message-id={item.id}>
                  <Item
                    item={item}
                    answer={answer}
                    busy={busy}
                    legacyTerminal={agent.mode === "tmux"}
                  />
                </div>
              ))}
              {visibleItems.length === 0 && (
                <p className="py-10 text-center text-sm text-muted">
                  {agent.mode === "tmux"
                    ? "暂无已保存的工作记录。你可以直接查看原终端，无需重新创建 Agent。"
                    : "准备就绪后，对话和工作进展会显示在这里。"}
                </p>
              )}
            </div>
          </div>
          {pendingNew && (
            <button
              className="absolute bottom-48 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--background)] px-3 py-1.5 text-xs shadow-sm"
              onClick={() => {
                follow.current = true;
                setPendingNew(false);
                scroll.current?.scrollTo({
                  top: scroll.current.scrollHeight,
                  behavior: "smooth",
                });
              }}
            >
              <ArrowDown size={13} />
              有新内容
            </button>
          )}
          <div className="agent-reading w-full shrink-0 pb-4 pt-2">
            {dataUnavailable && (
              <p role="alert" className="mb-2 text-xs text-[var(--danger)]">
                此 Agent 的 Workspace 数据已移除；对话和报告仍可查看。
              </p>
            )}
            {(error || agent.error) && (
              <p
                role="alert"
                className="mb-2 max-h-24 overflow-y-auto text-xs text-[var(--danger)]"
              >
                {error || agent.error}
              </p>
            )}
            {uncertain.length > 0 && (
              <details className="agent-request mb-2" open>
                <summary className="text-xs">
                  {uncertain.length} 次执行待核对
                </summary>
                <p className="my-2 text-xs text-muted">
                  先检查对话、变更或终端，再确认结果。核对只更新记录，不会重发指令。
                </p>
                {uncertain.map((run) => (
                  <div
                    key={run.id}
                    className="mb-2 flex flex-wrap items-center gap-2 text-xs"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {snapshot?.messages.find((m) => m.id === run.messageId)
                        ?.text ?? run.id}
                    </span>
                    {(["completed", "cancelled"] as const).map((resolution) => (
                      <Button
                        key={resolution}
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => {
                          if (
                            window.confirm(
                              "已检查远端状态，并确认本次执行结果？此操作不会回滚已产生的修改。",
                            )
                          )
                            void act(() =>
                              agentWorkspaceApi.reconcile(
                                id,
                                run.id,
                                resolution,
                              ),
                            );
                        }}
                      >
                        {resolution === "completed"
                          ? "已执行结束"
                          : "已中断／未执行"}
                      </Button>
                    ))}
                  </div>
                ))}
              </details>
            )}
            {pending.length > 0 && (
              <details open className="mb-2">
                <summary className="text-xs text-muted">
                  需要你回应 · {pending.length}
                </summary>
                <div className="max-h-[min(50dvh,480px)] space-y-2 overflow-y-auto">
                  {pending.map((item) => (
                    <Item
                      key={item.id}
                      item={item}
                      answer={answer}
                      busy={busy}
                      requestControls
                    />
                  ))}
                </div>
              </details>
            )}
            {["failed", "disconnected", "interrupted", "stopped"].includes(
              agent.state,
            ) && (
              <div className="mb-2 flex gap-2">
                <Button
                  size="sm"
                  disabled={busy || dataUnavailable}
                  onClick={() =>
                    void act(() =>
                      agentWorkspaceApi.action(
                        id,
                        agent.state === "failed" ? "retry" : "resume",
                      ),
                    )
                  }
                >
                  {agent.state === "failed"
                    ? "重试失败步骤"
                    : agent.state === "interrupted"
                      ? "继续队列"
                      : "恢复会话"}
                </Button>
                {!agent.canResume &&
                  agent.mode !== "tmux" &&
                  agent.remoteSessionId && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        if (
                          window.confirm(
                            "创建新的原生会话，保留历史和工作目录。请先确认旧进程已退出。",
                          )
                        )
                          void act(() =>
                            agentWorkspaceApi.action(id, "resume", {
                              newSession: true,
                            }),
                          );
                      }}
                    >
                      新会话继续
                    </Button>
                  )}
              </div>
            )}
            {queueOpen && queued.length > 0 && (
              <div className="mb-2 max-h-36 overflow-auto rounded-lg border border-[var(--border)]">
                {queued.map((item) => (
                  <div key={item.id} className="flex gap-2 p-2 text-xs">
                    <span className="min-w-0 flex-1 truncate">{item.text}</span>
                    <button
                      onClick={() => {
                        const text = window.prompt("编辑待发送消息", item.text);
                        if (text?.trim())
                          void act(() =>
                            agentWorkspaceApi.queue(
                              id,
                              String(item.data?.messageId),
                              { text },
                            ),
                          );
                      }}
                    >
                      编辑
                    </button>
                    <button
                      onClick={() =>
                        void act(() =>
                          agentWorkspaceApi.queue(
                            id,
                            String(item.data?.messageId),
                            { cancel: true },
                          ),
                        )
                      }
                    >
                      取消
                    </button>
                  </div>
                ))}
              </div>
            )}
            {canSend && (
              <AgentSuggestions
                items={items}
                onInsert={(text) => {
                  const value = draft.trim() ? `${draft}\n\n${text}` : text;
                  setDraft(value);
                  save(prefix + ":draft", value);
                  composer.current?.focus();
                }}
              />
            )}
            <form
              className="agent-composer"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <textarea
                ref={composer}
                aria-label="Agent 对话消息"
                value={draft}
                rows={3}
                maxLength={24000}
                placeholder={
                  agent.state === "running"
                    ? "补充要求，消息会加入队列…"
                    : "告诉 Agent 下一步做什么…"
                }
                onChange={(e) => {
                  setDraft(e.target.value);
                  save(prefix + ":draft", e.target.value);
                  e.target.style.height = "auto";
                  e.target.style.height =
                    Math.min(220, e.target.scrollHeight) + "px";
                }}
                onCompositionStart={() => {
                  composing.current = true;
                }}
                onCompositionEnd={() => {
                  composing.current = false;
                }}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !composing.current &&
                    !e.nativeEvent.isComposing &&
                    e.nativeEvent.keyCode !== 229 &&
                    !window.matchMedia("(pointer:coarse)").matches
                  ) {
                    e.preventDefault();
                    if (canSend && !busy) void send();
                  }
                }}
              />
              <div className="flex items-center gap-2 px-3 pb-2 text-xs text-muted">
                <AgentReferences
                  onInsert={(text) => {
                    const value = draft ? `${draft}\n\n${text}` : text;
                    setDraft(value);
                    save(prefix + ":draft", value);
                  }}
                />
                <span>
                  {agent.mode === "codex"
                    ? "Codex"
                    : agent.mode === "claude"
                      ? "Claude Code"
                      : agent.mode === "tmux"
                        ? "终端接入"
                        : "ACP"}
                  {agent.model ? ` · ${agent.model}` : ""}
                </span>
                <span className="hidden sm:inline">· 需审批</span>
                <button
                  type="button"
                  onClick={() => setPanel("workspace")}
                  className="ml-1 truncate"
                  title={agent.directory}
                >
                  工作目录
                </button>
                <div className="flex-1" />
                {queued.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setQueueOpen(!queueOpen)}
                  >
                    队列 {queued.length}
                  </button>
                )}
                {["running", "waiting"].includes(agent.state) && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label="中断执行"
                    disabled={busy}
                    onClick={() =>
                      void act(() => agentWorkspaceApi.action(id, "cancel"))
                    }
                  >
                    <Square size={13} />
                  </Button>
                )}
                <Button
                  type="submit"
                  size="sm"
                  aria-label={
                    agent.state === "running" ? "排队发送" : "发送消息"
                  }
                  disabled={
                    !canSend || busy || !draft.trim() || !navigator.onLine
                  }
                >
                  <ArrowUp size={15} />
                </Button>
              </div>
            </form>
          </div>
        </div>
        {panel && (
          <aside
            className="agent-context-panel relative"
            style={{ width: panelWidth }}
          >
            <div
              role="separator"
              tabIndex={0}
              aria-label="调整详情宽度"
              aria-orientation="vertical"
              aria-valuenow={panelWidth}
              aria-valuemin={300}
              aria-valuemax={480}
              className="absolute inset-y-0 -left-1 z-10 hidden w-2 cursor-col-resize md:block"
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                  e.preventDefault();
                  const next = Math.max(
                    300,
                    Math.min(
                      480,
                      panelWidth + (e.key === "ArrowLeft" ? 20 : -20),
                    ),
                  );
                  setPanelWidth(next);
                  save(panelKey, String(next));
                }
              }}
              onPointerDown={(e) => {
                e.preventDefault();
                const start = e.clientX,
                  width = panelWidth;
                e.currentTarget.setPointerCapture(e.pointerId);
                const move = (ev: PointerEvent) => {
                  const next = Math.max(
                    300,
                    Math.min(480, width + start - ev.clientX),
                  );
                  setPanelWidth(next);
                  save(panelKey, String(next));
                };
                const up = () => {
                  window.removeEventListener("pointermove", move);
                  window.removeEventListener("pointerup", up);
                  window.removeEventListener("pointercancel", up);
                };
                window.addEventListener("pointermove", move);
                window.addEventListener("pointerup", up, { once: true });
                window.addEventListener("pointercancel", up, { once: true });
              }}
            />

            <div className="flex h-[52px] shrink-0 items-center gap-3 border-b border-[var(--border)] px-3">
              {(["task", "changes", "workspace"] as const).map((key) => (
                <button
                  key={key}
                  aria-pressed={panel === key}
                  className={
                    panel === key ? "text-sm font-medium" : "text-sm text-muted"
                  }
                  onClick={() =>
                    key === "changes" ? openChanges() : setPanel(key)
                  }
                >
                  {
                    { task: "Task", changes: "变更", workspace: "Workspace" }[
                      key
                    ]
                  }
                </button>
              ))}
              <button
                className="ml-auto"
                aria-label="关闭详情"
                onClick={() => setPanel("")}
              >
                <X size={15} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-4">
              {panel === "task" && task && (
                <>
                  <h2 className="mb-4 font-medium">{task.title}</h2>
                  <TaskDescription
                    task={task}
                    draft={taskDraft}
                    textNode={task.kind === "node"}
                  />
                </>
              )}
              {panel === "workspace" && (
                <dl className="space-y-3 break-all text-xs leading-6">
                  <dt className="text-muted">Workspace</dt>
                  <dd>{agent.environmentId}</dd>
                  <dt className="text-muted">工作目录</dt>
                  <dd>{agent.directory}</dd>
                  <dt className="text-muted">分支</dt>
                  <dd>{agent.branch || "未设置"}</dd>
                  <dt className="text-muted">协议与能力</dt>
                  <dd>
                    {agent.capabilities?.version || agent.mode} ·{" "}
                    {agent.capabilities?.resume ? "可恢复" : "不支持原生恢复"}
                    {agent.capabilities?.approvals ? " · 支持审批" : ""}
                  </dd>
                  {agent.currentRound &&
                    !["accepted", "cancelled"].includes(
                      agent.currentRound.state,
                    ) && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => {
                          if (
                            window.confirm(
                              "取消本轮推进，保留 Task、代码和历史？",
                            )
                          )
                            void act(() =>
                              agentWorkspaceApi.cancelRound(
                                id,
                                agent.currentRound!.id,
                                { requestId: newUuid() },
                              ),
                            );
                        }}
                      >
                        取消本轮
                      </Button>
                    )}
                  {agent.mode === "tmux" && taskLink && (
                    <Link className="block underline" to={taskLink}>
                      返回 Task 创建结构化会话
                    </Link>
                  )}
                  <dt className="text-muted">原生会话</dt>
                  <dd>{agent.remoteSessionId || "正在准备"}</dd>
                  {agent.workArea?.owned && !agent.workArea.dataDeletedAt && (
                    <WorkAreaCleanup
                      id={id}
                      onCleaned={async () => {
                        await act(async () => {});
                      }}
                    />
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || agent.state === "stopped"}
                    onClick={() => {
                      if (
                        window.confirm(
                          "结束运行会话，保留工作目录、对话与报告。",
                        )
                      )
                        void act(() => agentWorkspaceApi.action(id, "stop"));
                    }}
                  >
                    结束 Agent
                  </Button>
                </dl>
              )}
              {panel === "changes" &&
                (changes ? (
                  <>
                    <p className="mb-3 text-xs text-muted">
                      Workspace Git ·{" "}
                      {new Date(changes.updatedAt).toLocaleTimeString()}
                      {changes.truncated ? " · 输出已截断" : ""}
                    </p>
                    <ChangePreview text={changes.text || "工作目录没有修改"} />
                  </>
                ) : (
                  <p className="text-xs text-muted">正在读取工作目录变更…</p>
                ))}
            </div>
          </aside>
        )}
      </div>
      {terminalOpen && terminal && (
        <section
          className={`agent-terminal ${fullscreen ? "agent-terminal-fullscreen" : ""}`}
        >
          {(error || agent.error) && (
            <p role="alert" className="px-3 py-2 text-xs text-[var(--danger)]">
              {error || agent.error}
            </p>
          )}
          <div className="flex min-h-8 shrink-0 flex-wrap items-center gap-2 px-3 text-xs">
            <button
              onClick={closeTerminal}
              className="shrink-0 underline underline-offset-4"
            >
              返回对话
            </button>
            <Terminal size={13} />
            <span className="min-w-0 flex-1 truncate" title={agent.directory}>
              {agent.directory}
            </span>
            <div className="flex max-w-[40%] gap-1 overflow-x-auto">
              {(agent.terminalPanes ?? [terminal]).map((pane, i) => (
                <button
                  key={pane.id}
                  aria-pressed={terminal.id === pane.id}
                  className="shrink-0 rounded px-2 py-1 hover:bg-[var(--surface)]"
                  onClick={() => setTerminal(pane)}
                >
                  终端 {i + 1}
                </button>
              ))}
            </div>
            {agent.mode !== "tmux" && (
              <>
                <button
                  aria-label="新建终端"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      terminalRequest.current ??= newUuid();
                      const pane = await agentWorkspaceApi.terminal(
                        id,
                        terminalRequest.current,
                      );
                      if (active()) {
                        setTerminal(pane);
                        terminalRequest.current = undefined;
                      }
                    })
                  }
                >
                  ＋
                </button>
                <button
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        "结束此终端会话及其中的 Shell 程序？Agent 对话会话不受影响。",
                      )
                    )
                      void act(async () => {
                        await agentWorkspaceApi.endTerminal(id, terminal.id);
                        if (active()) {
                          setTerminalOpen(false);
                          setTerminal(undefined);
                          save(prefix + ":terminal-open", "0");
                        }
                      });
                  }}
                >
                  结束终端
                </button>
              </>
            )}
            {agent.state === "running" && (
              <button
                onClick={() =>
                  void act(() => agentWorkspaceApi.action(id, "cancel"))
                }
              >
                中断执行后接手
              </button>
            )}
            <button
              aria-label="终端全屏"
              onClick={() => setFullscreen(!fullscreen)}
            >
              <Maximize2 size={13} />
            </button>
            <button aria-label="关闭终端" onClick={closeTerminal}>
              <X size={14} />
            </button>
          </div>
          <Suspense fallback={<p>正在连接终端…</p>}>
            <WorkspaceTerminal
              environmentId={agent.environmentId}
              pane={terminal}
              embedded
            />
          </Suspense>
        </section>
      )}
    </main>
  );
}
