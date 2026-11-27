import { expect, it } from "vitest";
import { agentProxyEnvironment, parseAgentProxy } from "../src/agentProxy";

it("bypasses local and Nexus callback addresses and keeps proxy removal distinct from updates", () => {
  expect(parseAgentProxy(undefined)).toBeUndefined();
  expect(parseAgentProxy(null)).toBeNull();
  expect(agentProxyEnvironment(null)).toEqual({});
  const proxy = parseAgentProxy({
    url: "http://127.0.0.1:7890/",
    noProxy: "internal.invalid, 127.0.0.1",
  });
  expect(proxy).toEqual({
    url: "http://127.0.0.1:7890",
    noProxy: "internal.invalid,127.0.0.1",
  });
  const env = agentProxyEnvironment(proxy, "http://nexus.internal:30090");
  expect(env.NO_PROXY).toBe(
    "localhost,127.0.0.1,::1,internal.invalid,nexus.internal",
  );
  expect(env.no_proxy).toBe(env.NO_PROXY);
  expect(() =>
    parseAgentProxy({ url: "http://proxy", noProxy: "$(touch /tmp/inject)" }),
  ).toThrow();
});
