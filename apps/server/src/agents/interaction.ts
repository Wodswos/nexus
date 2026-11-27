import type {
  AgentQuestion,
  AgentSuggestion,
} from "../../../../packages/core/src/index";
import { WorkspaceError } from "../workspaces/service";

const bounded = (value: unknown, max: number): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new WorkspaceError("问题或建议字段无效");
  return value.trim().replace(/nxa_[a-f0-9]{64}/gi, "[凭据已隐藏]");
};
export function readSuggestions(input: unknown): AgentSuggestion[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length > 4)
    throw new WorkspaceError("下一步建议最多 4 项");
  return input.map((row) => ({
    label: bounded(row?.label, 40),
    text: bounded(row?.text, 4000),
  }));
}
export function readQuestions(input: unknown): AgentQuestion[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || !input.length || input.length > 10)
    throw new WorkspaceError("请提供 1–10 个问题");
  const ids = new Set<string>();
  return input.map((row) => {
    const id = bounded(row?.id, 100);
    if (ids.has(id) || !/^[a-zA-Z0-9_-]+$/.test(id))
      throw new WorkspaceError(
        "问题 ID 必须唯一且只含字母、数字、下划线或连字符",
      );
    ids.add(id);
    const options = row.options ?? [];
    if (!Array.isArray(options) || options.length > 20)
      throw new WorkspaceError("问题选项最多 20 项");
    return {
      id,
      question: bounded(row.question, 4000),
      multiSelect: row.multiSelect === true,
      options: options.map((option) => ({
        label: bounded(option?.label, 500),
        description: option?.description
          ? bounded(option.description, 2000)
          : "",
      })),
    };
  });
}
export function questionAnswers(
  questions: Pick<AgentQuestion, "id" | "multiSelect">[],
  input: unknown,
) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new WorkspaceError("请填写每个问题的答案");
  return Object.fromEntries(
    questions.map((question) => {
      const raw = (input as Record<string, unknown>)[question.id];
      const values = Array.isArray(raw) ? raw : [raw];
      if (!values.length || values.length > (question.multiSelect ? 21 : 1))
        throw new WorkspaceError("问题答案数量无效");
      return [
        question.id,
        { answers: values.map((value) => bounded(value, 12000)) },
      ];
    }),
  );
}
