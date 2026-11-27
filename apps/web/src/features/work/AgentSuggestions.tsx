import React from "react";
import type { AgentSuggestion, ConversationItem } from "@nexus/core";

export function AgentSuggestions({
  items,
  onInsert,
}: {
  items: ConversationItem[];
  onInsert: (text: string) => void;
}) {
  let suggestions: AgentSuggestion[] = [];
  for (const item of [...items].reverse()) {
    if (item.kind === "user") break;
    if (Array.isArray(item.data?.suggestions)) {
      suggestions = item.data.suggestions
        .filter(
          (v): v is AgentSuggestion =>
            typeof v?.label === "string" && typeof v?.text === "string",
        )
        .slice(0, 4);
      break;
    }
  }
  const common = [
    {
      label: "发布",
      text: "请推进发布：依据项目约定检查发布范围与验证结果；若目标版本或发布渠道不明确，先向我确认。",
    },
    {
      label: "部署",
      text: "请推进部署：依据项目已有部署约定执行并检查健康状态；若目标环境或范围不明确，先向我确认。",
    },
    {
      label: "总结进展",
      text: "请总结目前已完成的内容、验证结果和未完成事项，并说明你建议的下一步。",
    },
  ];
  return (
    <div
      className="mb-2 flex flex-wrap items-center gap-1.5"
      aria-label="下一步消息建议"
    >
      <span className="mr-1 text-micro text-muted">
        {suggestions.length ? "Agent 建议" : "快捷消息"}
      </span>
      {(suggestions.length ? suggestions : common).map((value, index) => (
        <button
          type="button"
          key={index}
          title={value.text}
          className="rounded-[var(--radius-sm)] border border-[var(--border)] px-2 py-1 text-xs text-muted hover:bg-[var(--surface)] hover:text-foreground"
          onClick={() => onInsert(value.text)}
        >
          {value.label}
        </button>
      ))}
    </div>
  );
}
