import React, { useState } from "react";
import { Button, Dialog, DialogContent } from "@nexus/ui";
import {
  agentWorkspaceApi,
  type WorkAreaCleanupPlan,
} from "@/shared/agentWorkspaceApi";

export function WorkAreaCleanup({
  id,
  onCleaned,
}: {
  id: string;
  onCleaned: () => Promise<void>;
}) {
  const [plan, setPlan] = useState<WorkAreaCleanupPlan>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [confirmation, setConfirmation] = useState("");
  const inspect = async () => {
    setBusy(true);
    setError("");
    try {
      setPlan(await agentWorkspaceApi.workAreaPlan(id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "检查失败");
    } finally {
      setBusy(false);
    }
  };
  const blocked =
    !!plan &&
    (!!plan.blockers.length ||
      !!plan.inspectionError ||
      plan.inspection?.dirty ||
      plan.inspection?.unpushed ||
      !!plan.dataDeletedAt);
  return (
    <div className="space-y-2">
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => void inspect()}
      >
        清理独立工作目录…
      </Button>
      {!plan && error && <p role="alert">{error}</p>}
      <Dialog
        open={!!plan}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setPlan(undefined);
            setConfirmation("");
          }
        }}
      >
        <DialogContent title="清理工作目录" aria-describedby={undefined}>
          {plan && (
            <div className="space-y-4 text-sm">
              <p className="break-all">{plan.directory}</p>
              <p>
                清理目录后，此 Agent 无法继续运行。对话、报告、Git 分支与
                Workspace 保留。
              </p>
              <p>引用：{plan.agents.map((a) => a.name).join("、")}</p>
              {plan.branch && <p>保留分支：{plan.branch}</p>}
              {!!plan.artifacts.length && (
                <details>
                  <summary>已记录产物 · {plan.artifacts.length}</summary>
                  {plan.artifacts.map((a, i) => (
                    <p key={i} className="break-all">
                      {a}
                    </p>
                  ))}
                </details>
              )}
              {plan.blockers.map((text) => (
                <p key={text} role="alert">
                  {text}
                </p>
              ))}
              {plan.inspectionError && (
                <p role="alert">{plan.inspectionError}</p>
              )}
              {(plan.inspection?.dirty || plan.inspection?.unpushed) && (
                <p role="alert">
                  有未保存数据或未推送提交，请先保存并推送。普通目录需要先移走内容。
                </p>
              )}
              {plan.dataDeletedAt && <p>此目录已清理。</p>}
              {!blocked && (
                <label className="block">
                  输入完整路径确认
                  <input
                    className="mt-2 w-full rounded-md border border-[var(--border)] bg-transparent p-2"
                    aria-label="确认清理目录"
                    value={confirmation}
                    onChange={(e) => setConfirmation(e.target.value)}
                  />
                </label>
              )}
              {error && <p role="alert">{error}</p>}
              <div className="flex justify-end gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setPlan(undefined);
                    setConfirmation("");
                  }}
                >
                  取消
                </Button>
                <Button
                  size="sm"
                  disabled={busy || blocked || confirmation !== plan.directory}
                  onClick={() => {
                    setBusy(true);
                    setError("");
                    void agentWorkspaceApi
                      .cleanWorkArea(id, confirmation)
                      .then(async () => {
                        await onCleaned();
                        setPlan(undefined);
                        setConfirmation("");
                      })
                      .catch((e) => setError(e.message))
                      .finally(() => setBusy(false));
                  }}
                >
                  确认清理
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
