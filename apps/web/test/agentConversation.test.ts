import { expect, it } from "vitest";
import { applyConversationEvent } from "../src/features/work/conversation";
it("does not insert invisible rows while preserving delivery acknowledgements and message identity", () => {
  const user = applyConversationEvent([], {
    id: 1,
    agentId: "a",
    kind: "user",
    text: "继续任务",
    data: { messageId: "message", state: "sending" },
    createdAt: 1,
  });
  expect(
    applyConversationEvent(user, {
      id: 2,
      agentId: "a",
      kind: "status",
      text: "已连接",
      createdAt: 2,
    }),
  ).toBe(user);
  const updated = applyConversationEvent(user, {
    id: 3,
    agentId: "a",
    kind: "status",
    text: "已接收",
    data: { messageId: "message", state: "delivered" },
    createdAt: 3,
  });
  expect(updated).toHaveLength(1);
  expect(updated[0]).toMatchObject({
    id: user[0]!.id,
    text: "继续任务",
    data: { state: "delivered" },
  });
});
