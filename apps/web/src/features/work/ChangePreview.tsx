import React, { useMemo, useState } from "react";
import { Button } from "@nexus/ui";
export function ChangePreview({ text }: { text: string }) {
  const [split, setSplit] = useState(false);
  const lines = useMemo(() => text.split("\n"), [text]);
  const pairs = useMemo(() => {
    const result: { left: string; right: string; kind: string }[] = [];
    let removed: string[] = [],
      added: string[] = [];
    const flush = () => {
      for (let i = 0; i < Math.max(removed.length, added.length); i++)
        result.push({
          left: removed[i] ?? "",
          right: added[i] ?? "",
          kind: "change",
        });
      removed = [];
      added = [];
    };
    for (const line of lines) {
      if (line.startsWith("-") && !line.startsWith("---")) removed.push(line);
      else if (line.startsWith("+") && !line.startsWith("+++"))
        added.push(line);
      else {
        flush();
        result.push({ left: line, right: line, kind: "context" });
      }
    }
    flush();
    return result;
  }, [lines]);
  const color = (line: string) =>
    line.startsWith("+")
      ? "bg-[var(--success)]/10"
      : line.startsWith("-")
        ? "bg-[var(--danger)]/10"
        : line.startsWith("@@")
          ? "bg-[var(--surface)] text-muted"
          : "";
  return (
    <section aria-label="Git 变更">
      <div className="mb-2 hidden gap-1 md:flex">
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={!split}
          onClick={() => setSplit(false)}
        >
          统一
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={split}
          onClick={() => setSplit(true)}
        >
          并排
        </Button>
      </div>
      <div className="overflow-auto rounded-[var(--radius-sm)] border border-[var(--border)] font-mono text-micro leading-5">
        {split ? (
          <table className="hidden w-full table-fixed border-collapse md:table">
            <thead>
              <tr className="text-left text-muted">
                <th>修改前</th>
                <th>修改后</th>
              </tr>
            </thead>
            <tbody>
              {pairs.map((pair, i) => (
                <tr key={i}>
                  <td
                    className={`whitespace-pre-wrap break-all border-r border-[var(--border)] px-2 align-top ${pair.kind === "change" ? "bg-[var(--danger)]/10" : ""}`}
                  >
                    {pair.left || " "}
                  </td>
                  <td
                    className={`whitespace-pre-wrap break-all px-2 align-top ${pair.kind === "change" ? "bg-[var(--success)]/10" : ""}`}
                  >
                    {pair.right || " "}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        <pre className={`m-0 ${split ? "md:hidden" : ""}`}>
          {lines.map((line, i) => (
            <span key={i} className={`block min-h-5 px-2 ${color(line)}`}>
              {line || " "}
            </span>
          ))}
        </pre>
      </div>
    </section>
  );
}
