import React, { useEffect, useState } from "react";
import { Button, SelectField } from "@nexus/ui";
import { useNexus, currentStore } from "@nexus/crdt";
import { agentWorkspaceApi } from "./agentWorkspaceApi";
import type { NodeWorkspaceBinding, WorkspaceEnvironment } from "@nexus/core";
export function WorkspaceBindings({
  taskId,
  onChange,
}: {
  taskId: string;
  onChange?: () => void;
}) {
  const store = useNexus();
  const [bindings, setBindings] = useState<
      (NodeWorkspaceBinding & {
        inherited: boolean;
        environment: WorkspaceEnvironment;
      })[]
    >([]),
    [environments, setEnvironments] = useState<WorkspaceEnvironment[]>([]),
    [inherit, setInherit] = useState(true),
    [selected, setSelected] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let done = false;
    void Promise.all([
      agentWorkspaceApi.bindings(taskId),
      agentWorkspaceApi.environments(),
    ])
      .then(([rows, values]) => {
        if (!done && currentStore() === store) {
          setBindings(rows);
          setEnvironments(
            values.filter((v) => !v.archivedAt && v.state !== "stopped"),
          );
        }
      })
      .catch((e) => {
        if (!done) setError(e.message);
      });
    return () => {
      done = true;
    };
  }, [taskId, store]);
  const bind = async (environmentId: string, remove = false) => {
    setBusy(true);
    try {
      await agentWorkspaceApi.bind(taskId, {
        environmentId,
        remove,
        inherit,
      });
      const rows = await agentWorkspaceApi.bindings(taskId);
      if (currentStore() === store) {
        setBindings(rows);
        setSelected("");
        onChange?.();
      }
    } catch (e) {
      if (currentStore() === store)
        setError(e instanceof Error ? e.message : "关联失败");
    } finally {
      if (currentStore() === store) setBusy(false);
    }
  };
  return (
    <details className="text-xs">
      <summary className="cursor-pointer py-2 text-muted">
        关联其他 Workspace{bindings.length ? ` · ${bindings.length}` : ""}
      </summary>
      <div className="space-y-2 py-2">
        {bindings.map((b) => (
          <div
            key={b.id}
            className="flex gap-2 rounded-[var(--radius-sm)] bg-[var(--surface)] p-2"
          >
            <span className="min-w-0 flex-1 truncate">
              {b.environment.name || b.environmentId}
              {b.inherited ? " · 从祖先继承" : ""}
            </span>
            {!b.inherited && (
              <button
                disabled={busy}
                onClick={() => void bind(b.environmentId, true)}
              >
                解除关联
              </button>
            )}
          </div>
        ))}
        <div className="flex gap-2">
          <SelectField
            aria-label="关联已有 Workspace"
            value={selected}
            onValueChange={setSelected}
            options={[
              { value: "", label: "选择账号内已有 Workspace" },
              ...environments
                .filter((e) => !bindings.some((b) => b.environmentId === e.id))
                .map((e) => ({ value: e.id, label: e.name || e.id })),
            ]}
            className="min-w-0 flex-1"
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!selected || busy}
            onClick={() => void bind(selected)}
          >
            关联
          </Button>
        </div>
        <label className="flex items-center gap-2 text-muted">
          <input
            type="checkbox"
            checked={inherit}
            onChange={(e) => setInherit(e.target.checked)}
          />
          关联后可用于子节点
        </label>
        {error && (
          <p role="alert" className="text-[var(--danger)]">
            {error}
          </p>
        )}
      </div>
    </details>
  );
}
