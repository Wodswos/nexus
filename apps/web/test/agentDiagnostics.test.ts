import { expect, it } from "vitest";
import {
  agentDiagnostic,
  readableAgentLog,
} from "../src/features/work/agentDiagnostics";

it("renders colored CLI diagnostics and terminal hyperlinks as plain text without removing Chinese output", () => {
  const log =
    "\x1b[2m2026-11-27T02:58:07Z\x1b[0m \x1b[31mERROR\x1b[0m failed to refresh available models: request timed out\n中文";
  expect(agentDiagnostic(log)).toMatchObject({
    title: "模型列表连接超时",
    log: "2026-11-27T02:58:07Z ERROR failed to refresh available models: request timed out\n中文",
  });
  expect(
    readableAgentLog("\x1b]8;;https://example.com\x07文档\x1b]8;;\x07"),
  ).toBe("文档");
  expect(agentDiagnostic("Reconnecting... waiting for network").title).toBe(
    "Codex 正在等待网络恢复",
  );
  expect(agentDiagnostic("fatal: repository unavailable")).toMatchObject({
    log: "fatal: repository unavailable",
    hint: undefined,
  });
});
