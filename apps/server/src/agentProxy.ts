import type { ServerConfig } from "../../../packages/core/src/types";

export function parseAgentProxy(value: unknown): ServerConfig["agentProxy"] {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error("Agent 代理配置无效");
  const { url, noProxy = "" } = value as Record<string, unknown>;
  if (
    typeof url !== "string" ||
    url.length > 2048 ||
    /[\s\\\x00-\x1f]/.test(url)
  )
    throw new Error("代理地址无效");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      "代理地址需要包含 http://、https://、socks5:// 或 socks5h://",
    );
  }
  if (
    !["http:", "https:", "socks5:", "socks5h:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !["", "/"].includes(parsed.pathname)
  )
    throw new Error(
      "代理地址仅支持主机和端口，不能包含账号、密码、路径或查询参数",
    );
  if (
    typeof noProxy !== "string" ||
    noProxy.length > 4096 ||
    !/^[a-zA-Z0-9.*,:/\[\]\s-]*$/.test(noProxy) ||
    /[\r\n]/.test(noProxy)
  )
    throw new Error("不经过代理的地址应使用逗号分隔的主机或 IP");
  return {
    url: parsed.href.replace(/\/$/, ""),
    noProxy: noProxy
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .join(","),
  };
}

/** These variables run on the execution host, never on Nexus's SSH client. */
export function agentProxyEnvironment(
  proxy: ServerConfig["agentProxy"],
  callbackOrigin?: string,
): Record<string, string> {
  if (!proxy) return {};
  const bypass = ["localhost", "127.0.0.1", "::1", ...proxy.noProxy.split(",")];
  if (callbackOrigin)
    bypass.push(new URL(callbackOrigin).hostname.replace(/^\[|\]$/g, ""));
  const noProxy = [...new Set(bypass.filter(Boolean))].join(",");
  return {
    HTTP_PROXY: proxy.url,
    HTTPS_PROXY: proxy.url,
    ALL_PROXY: proxy.url,
    http_proxy: proxy.url,
    https_proxy: proxy.url,
    all_proxy: proxy.url,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
}
