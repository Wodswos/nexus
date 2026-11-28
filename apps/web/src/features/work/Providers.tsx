import React, { useEffect, useState } from "react";
import { Button, Dialog, DialogContent, SelectField } from "@nexus/ui";
import type { ProviderInstance } from "@nexus/core";
import { currentStore, useNexus } from "@nexus/crdt";
import { agentWorkspaceApi } from "@/shared/agentWorkspaceApi";
export function Providers() {
  const store = useNexus();
  const [values, setValues] = useState<ProviderInstance[]>([]),
    [draft, setDraft] = useState<Partial<ProviderInstance>>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let done = false;
    void agentWorkspaceApi
      .providers()
      .then((values) => {
        if (!done && currentStore() === store) setValues(values);
      })
      .catch((e) => {
        if (!done) setError(e.message);
      });
    return () => {
      done = true;
    };
  }, [store]);
  const save = async () => {
    if (!draft || busy) return;
    setBusy(true);
    setError("");
    try {
      await agentWorkspaceApi.saveProvider(draft);
      const rows = await agentWorkspaceApi.providers();
      if (currentStore() === store) {
        setValues(rows);
        setDraft(undefined);
      }
    } catch (e) {
      if (currentStore() === store)
        setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      if (currentStore() === store) setBusy(false);
    }
  };
  return (
    <section className="space-y-3" aria-label="Provider 配置">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Agent 产品配置</h2>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            setDraft({
              name: "Codex",
              harness: "codex",
              command: "codex app-server",
            })
          }
        >
          添加配置
        </Button>
      </div>
      <p className="text-xs text-muted">
        配置模型与执行侧凭据目录。安装和登录在目标 Workspace 中完成。
      </p>
      {values.map((value) => (
        <button
          key={value.id}
          className="flex w-full items-center gap-3 rounded-[var(--radius-md)] border border-[var(--border)] px-3 py-2 text-left text-sm"
          onClick={() => setDraft(value)}
        >
          <span className="flex-1">{value.name}</span>
          <span className="text-xs text-muted">
            {value.harness} · {value.model || "默认模型"}
          </span>
        </button>
      ))}
      {error && (
        <p role="alert" className="text-xs text-[var(--danger)]">
          {error}
        </p>
      )}
      <Dialog
        open={!!draft}
        onOpenChange={(open) => {
          if (!open && !busy) setDraft(undefined);
        }}
      >
        <DialogContent title="Agent 产品配置" aria-describedby={undefined}>
          {draft && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
              className="space-y-4"
            >
              <label className="block text-xs">
                名称
                <input
                  required
                  value={draft.name ?? ""}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  className="mt-1 w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-transparent p-2"
                />
              </label>
              <SelectField
                aria-label="Harness"
                value={draft.harness ?? "codex"}
                onValueChange={(value) =>
                  setDraft({
                    ...draft,
                    harness: value as ProviderInstance["harness"],
                    command:
                      value === "codex"
                        ? "codex app-server"
                        : value === "claude"
                          ? "node"
                          : "",
                  })
                }
                options={[
                  { value: "codex", label: "Codex App Server" },
                  { value: "claude", label: "Claude Agent SDK" },
                  { value: "acp", label: "通用 ACP / DSH 适配器" },
                ]}
              />
              {[
                ["command", "启动命令"],
                ["model", "模型（可选）"],
                ["configDirectory", "执行侧产品配置目录（可选）"],
              ].map(([key, label]) => (
                <label key={key} className="block text-xs">
                  {label}
                  <input
                    value={String(draft[key as keyof ProviderInstance] ?? "")}
                    onChange={(e) =>
                      setDraft({ ...draft, [key!]: e.target.value })
                    }
                    className="mt-1 w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-transparent p-2"
                  />
                </label>
              ))}
              <div className="flex justify-end gap-2">
                {draft.id && (
                  <Button
                    type="button"
                    size="sm"
                    variant="danger"
                    disabled={busy}
                    onClick={() => {
                      if (!window.confirm("删除此产品配置？")) return;
                      setBusy(true);
                      void agentWorkspaceApi
                        .deleteProvider(draft.id!)
                        .then(() => {
                          setValues((old) =>
                            old.filter((v) => v.id !== draft.id),
                          );
                          setDraft(undefined);
                        })
                        .catch((e) => setError(e.message))
                        .finally(() => setBusy(false));
                    }}
                  >
                    删除
                  </Button>
                )}
                <Button type="submit" size="sm" disabled={busy}>
                  保存配置
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
