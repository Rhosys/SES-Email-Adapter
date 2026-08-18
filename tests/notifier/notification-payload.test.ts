import { describe, it, expect } from "vitest";
import type { NotificationPayload } from "../../src/notifier/types.js";

describe("NotificationPayload type shape", () => {
  it("type is 'thread:updated' and includes signalId + threadId", () => {
    const payload: NotificationPayload = {
      type: "thread:updated",
      signalId: "sgn-test",
      threadId: "thr-test",
      from: { address: "sender@example.com", name: "Sender" },
      subject: "Test subject",
      workflow: "conversation",
      urgency: "normal",
    };

    expect(payload.type).toBe("thread:updated");
    expect(payload.signalId).toBeDefined();
    expect(payload.threadId).toBeDefined();
  });
});
