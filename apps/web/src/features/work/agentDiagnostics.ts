/** Terminal escape sequences are meaningful in a terminal, not in a text log. */
export function readableAgentLog(text: string): string {
  return text
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

export function agentDiagnostic(text: string) {
  const log = readableAgentLog(text);
  if (
    /failed to (?:refresh available models|initialize model catalog).*timed out/i.test(
      log,
    )
  )
    return {
      log,
      title: "模型列表连接超时",
      hint: "检查 Codex 所在执行环境的网络与代理。模型列表刷新失败本身不等于会话启动失败。",
    };
  if (/Reconnecting\.\.\. waiting for network/i.test(log))
    return {
      log,
      title: "Codex 正在等待网络恢复",
      hint: "请检查执行环境能否访问模型服务，以及 Agent 进程是否加载了代理配置。",
    };
  return { log, title: "诊断日志", hint: undefined };
}
