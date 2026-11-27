import React, { useEffect, useRef, useState } from "react";
import { Box, Plus, Settings2 } from "lucide-react";
import { Button } from "@nexus/ui";
import { currentStore, useNexus } from "@nexus/crdt";
import {
  agentWorkspaceApi,
  type WorkspaceProfileView,
} from "@/shared/agentWorkspaceApi";
import { WorkspaceConfiguration } from "@/shared/WorkspaceConfiguration";
import { Providers } from "./Providers";
import { WorkspaceEnvironments } from "@/shared/WorkspaceEnvironments";

export default function WorkspaceTemplatesPage() {
  const store = useNexus();
  const [profiles, setProfiles] = useState<WorkspaceProfileView[]>([]);
  const [editing, setEditing] = useState<WorkspaceProfileView | "new" | null>(
    null,
  );
  const [error, setError] = useState(""),
    [loaded, setLoaded] = useState(false);
  const live = useRef(true);
  const refresh = async () => {
    try {
      const values = await agentWorkspaceApi.profiles();
      if (live.current && currentStore() === store) {
        setProfiles(values);
        setError("");
      }
    } catch (reason) {
      if (live.current && currentStore() === store)
        setError(reason instanceof Error ? reason.message : "读取失败");
    } finally {
      if (live.current && currentStore() === store) setLoaded(true);
    }
  };
  useEffect(() => {
    live.current = true;
    void refresh();
    return () => {
      live.current = false;
    };
  }, [store]);
  return (
    <main className="mx-auto w-full max-w-4xl space-y-7 overflow-y-auto px-5 py-6 sm:px-8">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Workspace 与模板</h1>
          <p className="mt-1 text-xs leading-6 text-muted">
            模板保存配置；Workspace 承载仓库与 Agent 的实际运行。
          </p>
        </div>
        <Button size="sm" onClick={() => setEditing("new")}>
          <Plus size={14} />
          创建模板
        </Button>
      </header>
      <section aria-label="Workspace 模板" className="space-y-3">
        <h2 className="text-sm font-medium">Workspace 模板</h2>
        {profiles.map((profile) => (
          <button
            key={profile.id}
            onClick={() => setEditing(profile)}
            className="flex w-full items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--border)] px-4 py-3 text-left hover:bg-[var(--surface)]"
          >
            <Box size={18} className="shrink-0 text-muted" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm">{profile.name}</span>
              <span className="block truncate text-xs leading-6 text-muted">
                {profile.config.runtime} ·{" "}
                {profile.config.repository ||
                  profile.config.localRepository ||
                  "未指定仓库"}
              </span>
            </span>
            <Settings2 size={15} className="text-muted" />
          </button>
        ))}
        {loaded && !profiles.length && (
          <p className="rounded-[var(--radius-lg)] border border-dashed border-[var(--border)] p-5 text-xs leading-6 text-muted">
            创建一个模板，在项目中设为默认；新建 Agent
            时也可以为这一次选择其他模板。
          </p>
        )}
        {error && (
          <p role="alert" className="text-xs text-[var(--danger)]">
            {error}
          </p>
        )}
      </section>
      <WorkspaceEnvironments />
      <Providers key={store.userId} />
      {editing && (
        <WorkspaceConfiguration
          key={editing === "new" ? "new" : editing.id}
          taskId=""
          manageProfile={editing}
          onClose={() => {
            setEditing(null);
            void refresh();
          }}
        />
      )}
    </main>
  );
}
