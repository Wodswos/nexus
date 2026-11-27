import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { AgentStore } from "../src/agents/store";
import type { AgentEvent } from "../../../packages/core/src/index";
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function setup() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const store = new AgentStore(db);
  let id = 0;
  const event = (
    kind: AgentEvent["kind"],
    text: string,
    data?: Record<string, unknown>,
    owner = "alice",
  ) =>
    store.project(owner, {
      id: ++id,
      agentId: "legacy",
      kind,
      text,
      data,
      createdAt: id,
    });
  return { db, store, event };
}
it("pages readable content past hundreds of invisible status events and keeps old terminal captures in storage", () => {
  const { db, store, event } = setup();
  event("user", "原来的工作指令", { messageId: "original", state: "sending" });
  for (let i = 0; i < 65; i++) event("terminal", `终端快照 ${i}`);
  event("report", "已提交本轮报告");
  for (let i = 0; i < 270; i++) event("status", "正在检查连接");
  event("status", "已投递", { messageId: "original", state: "delivered" });
  event("assistant", "其他账号的回复", undefined, "bob");
  const latest = store.page("alice", "legacy", undefined, 100, true);
  expect(latest.items.map((i) => i.text)).toEqual([
    "原来的工作指令",
    "终端快照 64",
    "已提交本轮报告",
  ]);
  expect(latest.items[0]?.data?.state).toBe("delivered");
  expect(latest.hasMore).toBe(false);
  const first = store.page("alice", "legacy", undefined, 2, true);
  expect(first.hasMore).toBe(true);
  const earlier = store.page(
    "alice",
    "legacy",
    first.items[0]!.sequence,
    2,
    true,
  );
  expect(earlier.items.map((i) => i.text)).toEqual(["原来的工作指令"]);
  expect(earlier.hasMore).toBe(false);
  expect(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM agent_conversation WHERE owner='alice' AND json_extract(payload,'$.kind')='terminal'",
      )
      .get()?.n,
  ).toBe(65);
  expect(store.page("other", "legacy").items).toEqual([]);
});
it("keeps native startup logs and returns a real empty page when only status events exist", () => {
  const { store, event } = setup();
  for (let i = 0; i < 110; i++) event("status", "状态");
  expect(store.page("alice", "legacy")).toEqual({ items: [], hasMore: false });
  event("terminal", "启动步骤一");
  event("terminal", "启动步骤二");
  expect(store.page("alice", "legacy").items.map((i) => i.text)).toEqual([
    "启动步骤一",
    "启动步骤二",
  ]);
});
