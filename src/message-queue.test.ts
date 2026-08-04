import { describe, it, expect } from "vitest";
import {
  enqueuePendingNotification,
  enqueueTaskNotification,
  consumePendingNotifications,
  hasPendingNotifications,
  clearNotifications,
} from "./message-queue.ts";

describe("message-queue（S6）", () => {
  it("next 优先于 later 消费", () => {
    clearNotifications();
    enqueuePendingNotification("later-msg");
    enqueuePendingNotification("next-msg", "next");
    const consumed = consumePendingNotifications();
    expect(consumed).toEqual(["next-msg", "later-msg"]);
  });

  it("消费后队列清空", () => {
    clearNotifications();
    enqueuePendingNotification("a");
    consumePendingNotifications();
    expect(hasPendingNotifications()).toBe(false);
    expect(consumePendingNotifications()).toEqual([]);
  });

  it("recipient 过滤：指定名字只消费该 agent 的通知", () => {
    clearNotifications();
    enqueuePendingNotification("global");
    enqueuePendingNotification("for-worker", "later", { recipient: "worker-1" });
    const worker = consumePendingNotifications({ recipient: "worker-1" });
    expect(worker).toEqual(["for-worker"]);
    const lead = consumePendingNotifications();
    expect(lead).toEqual(["global"]);
  });

  it("enqueueTaskNotification 生成结构化 XML", () => {
    clearNotifications();
    enqueueTaskNotification("completed", "task done");
    const [msg] = consumePendingNotifications();
    expect(msg).toContain("<task_notification>");
    expect(msg).toContain("<status>completed</status>");
    expect(msg).toContain("<summary>task done</summary>");
  });
});
