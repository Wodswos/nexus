import React, { useState } from "react";
import { Button, Dialog, DialogContent } from "@nexus/ui";
import { apiUrl, useNexusData } from "@nexus/crdt";
import { Plus } from "lucide-react";

export function AgentReferences({
  onInsert,
}: {
  onInsert: (text: string) => void;
}) {
  const data = useNexusData(),
    [open, setOpen] = useState(false),
    [query, setQuery] = useState(""),
    [path, setPath] = useState("");
  const insert = (value: string) => {
    onInsert(value);
    setOpen(false);
    setQuery("");
    setPath("");
  };
  return (
    <>
      <button
        type="button"
        aria-label="添加引用"
        title="引用 Task 或工作目录中的文件"
        onClick={() => setOpen(true)}
      >
        <Plus size={16} />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title="添加引用" aria-describedby={undefined}>
          <label className="mb-4 block text-sm">
            工作目录中的文件路径
            <div className="mt-2 flex gap-2">
              <input
                aria-label="引用文件路径"
                className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-transparent p-2"
                placeholder="src/example.ts"
                value={path}
                onChange={(e) => setPath(e.target.value)}
              />
              <Button
                size="sm"
                disabled={!path.trim()}
                onClick={() =>
                  insert(`参考文件（相对于当前工作目录）：${path.trim()}`)
                }
              >
                引用文件
              </Button>
            </div>
          </label>
          <label className="block text-sm">
            Task
            <input
              aria-label="搜索引用 Task"
              className="my-2 w-full rounded-md border border-[var(--border)] bg-transparent p-2"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索任务标题…"
            />
          </label>
          <div className="max-h-56 overflow-auto">
            {data.tasks
              .filter(
                (t) =>
                  !t.deletedAt &&
                  t.title.toLowerCase().includes(query.toLowerCase()),
              )
              .slice(0, 40)
              .map((t) => (
                <button
                  type="button"
                  key={t.id}
                  className="block w-full truncate rounded px-2 py-2 text-left text-sm hover:bg-[var(--surface)]"
                  onClick={() =>
                    insert(
                      `参考 Task「${t.title}」（提供当前正文供参考，不扩大执行凭据权限）：\n${new URL(apiUrl(`/tasks?focusTask=${encodeURIComponent(t.id)}`),location.origin).href}\n${(t.notes || "").slice(0, 8000)}`,
                    )
                  }
                >
                  {t.title}
                </button>
              ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
