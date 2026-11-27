import React, { useState } from "react";
import { Button } from "@nexus/ui";
import type { AgentQuestion } from "@nexus/core";

export function AgentQuestionForm({
  questions,
  busy,
  onAnswer,
}: {
  questions: AgentQuestion[];
  busy: boolean;
  onAnswer: (answers: Record<string, string | string[]>) => void;
}) {
  const [choices, setChoices] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const answers = Object.fromEntries(
    questions.map((q) => {
      const selected = choices[q.id] ?? [],
        text = custom[q.id]?.trim();
      return [
        q.id,
        q.multiSelect
          ? [...selected, ...(text ? [text] : [])]
          : text || selected[0] || "",
      ];
    }),
  );
  const ready = Object.values(answers).every((value) => value.length > 0);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !busy) onAnswer(answers);
      }}
      className="space-y-4"
    >
      {questions.map((q) => (
        <fieldset key={q.id} disabled={busy} className="min-w-0 space-y-2">
          <legend className="mb-2 text-sm font-medium">
            {q.question}
            {q.multiSelect && (
              <span className="ml-2 text-xs font-normal text-muted">
                可多选
              </span>
            )}
          </legend>
          {q.options.map((option) => (
            <button
              key={option.label}
              type="button"
              aria-pressed={(choices[q.id] ?? []).includes(option.label)}
              className="flex w-full items-start gap-2 rounded-md border border-[var(--border)] px-3 py-2 text-left aria-pressed:border-[var(--accent-solid)] aria-pressed:bg-[var(--surface-raised)]"
              onClick={() => {
                setChoices((old) => ({
                  ...old,
                  [q.id]: q.multiSelect
                    ? (old[q.id] ?? []).includes(option.label)
                      ? old[q.id]!.filter((v) => v !== option.label)
                      : [...(old[q.id] ?? []), option.label]
                    : [option.label],
                }));
                if (!q.multiSelect)
                  setCustom((old) => ({ ...old, [q.id]: "" }));
              }}
            >
              <span aria-hidden="true" className="mt-0.5 w-3 shrink-0 text-xs">
                {(choices[q.id] ?? []).includes(option.label) ? "✓" : "○"}
              </span>
              <span className="min-w-0">
                <span className="block text-sm">{option.label}</span>
                {option.description && (
                  <span className="mt-0.5 block text-xs leading-5 text-muted">
                    {option.description}
                  </span>
                )}
              </span>
            </button>
          ))}
          <input
            aria-label={`自定义回答：${q.question}`}
            placeholder="也可以输入自己的回答…"
            maxLength={12000}
            value={custom[q.id] ?? ""}
            onChange={(event) => {
              setCustom((old) => ({ ...old, [q.id]: event.target.value }));
              if (!q.multiSelect) setChoices((old) => ({ ...old, [q.id]: [] }));
            }}
            className="w-full rounded-md border border-[var(--border)] bg-transparent px-3 py-2 text-sm"
          />
        </fieldset>
      ))}
      <Button size="sm" type="submit" disabled={busy || !ready}>
        发送回答
      </Button>
    </form>
  );
}
