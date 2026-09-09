import assert from "node:assert/strict";
import test from "node:test";

import type { WecomMarkdownSender } from "../alerts/wecom/wecom.client.ts";
import { WecomDeliveryAmbiguousError } from "../alerts/wecom/wecom.client.ts";
import type {
  CollectorSessionIncidentDelivery,
  CollectorSessionIncidentRepository
} from "./collector-session-incident.repository.ts";
import {
  CollectorSessionIncidentNotifier,
  createCollectorSessionWecomSender
} from "./collector-session-notifier.ts";

class FakeIncidentRepository implements CollectorSessionIncidentRepository {
  incident: CollectorSessionIncidentDelivery | null = {
    id: "incident-1",
    agentId: "agent-1",
    agentName: "固定采集 Mac",
    state: "LOGIN_REQUIRED",
    openedAt: new Date("2026-09-09T01:30:00.000Z")
  };
  state: "PENDING" | "SENDING" | "NOTIFIED" | "AMBIGUOUS" | "FAILED" = "PENDING";
  attempts = 0;
  errors: string[] = [];

  async observeBlocked() { return "incident-1"; }
  async observeReady() {}
  async claimPending() {
    if (!this.incident || this.state !== "PENDING" || this.attempts >= 2) return null;
    this.state = "SENDING";
    this.attempts += 1;
    return this.incident;
  }
  async markNotified() { this.state = "NOTIFIED"; }
  async markFailure(_id: string, code: "WECOM_NOT_CONFIGURED" | "WECOM_DELIVERY_FAILED" | "WECOM_DELIVERY_AMBIGUOUS") {
    this.errors.push(code);
    this.state = code === "WECOM_DELIVERY_AMBIGUOUS"
      ? "AMBIGUOUS"
      : this.attempts >= 2 ? "FAILED" : "PENDING";
  }
}

class RecordingSender implements WecomMarkdownSender {
  readonly messages: string[] = [];
  failure: Error | null = null;

  async sendMarkdown(message: string): Promise<void> {
    this.messages.push(message);
    if (this.failure) throw this.failure;
  }
}

test("collector session sender performs one HTTP POST per durable attempt", async () => {
  let requests = 0;
  const sender = createCollectorSessionWecomSender(
    "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-key",
    async () => {
      requests += 1;
      return new Response(JSON.stringify({ errcode: 93000 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  );

  await assert.rejects(sender.sendMarkdown("test"), /企业微信通知发送失败/);
  assert.equal(requests, 1);
});

test("sends one Enterprise WeChat message for a blocked episode", async () => {
  const repository = new FakeIncidentRepository();
  const sender = new RecordingSender();
  const notifier = new CollectorSessionIncidentNotifier(
    repository,
    async () => sender,
    async () => true,
    () => new Date("2026-09-09T01:31:00.000Z")
  );

  await notifier.notifyPending("agent-1");
  await notifier.notifyPending("agent-1");

  assert.equal(sender.messages.length, 1);
  assert.equal(repository.state, "NOTIFIED");
});

test("does not claim an incident while live sending is unapproved", async () => {
  const repository = new FakeIncidentRepository();
  const sender = new RecordingSender();
  const notifier = new CollectorSessionIncidentNotifier(repository, async () => sender, async () => false);

  await notifier.notifyPending("agent-1");

  assert.equal(repository.attempts, 0);
  assert.equal(repository.state, "PENDING");
  assert.equal(sender.messages.length, 0);
});

test("records missing configuration and bounds explicit delivery retries", async () => {
  const repository = new FakeIncidentRepository();
  const notifier = new CollectorSessionIncidentNotifier(repository, async () => null, async () => true);

  await notifier.notifyPending("agent-1");
  await notifier.notifyPending("agent-1");
  await notifier.notifyPending("agent-1");

  assert.deepEqual(repository.errors, ["WECOM_NOT_CONFIGURED", "WECOM_NOT_CONFIGURED"]);
  assert.equal(repository.state, "FAILED");
});

test("records an explicit send failure without exposing the original error", async () => {
  const repository = new FakeIncidentRepository();
  const sender = new RecordingSender();
  sender.failure = new Error("webhook secret must not be persisted");
  const notifier = new CollectorSessionIncidentNotifier(repository, async () => sender, async () => true);

  await notifier.notifyPending("agent-1");

  assert.deepEqual(repository.errors, ["WECOM_DELIVERY_FAILED"]);
  assert.equal(repository.state, "PENDING");
});

test("ambiguous delivery is terminal and is never posted twice", async () => {
  const repository = new FakeIncidentRepository();
  const sender = new RecordingSender();
  sender.failure = new WecomDeliveryAmbiguousError();
  const notifier = new CollectorSessionIncidentNotifier(repository, async () => sender, async () => true);

  await notifier.notifyPending("agent-1");
  await notifier.notifyPending("agent-1");

  assert.equal(sender.messages.length, 1);
  assert.deepEqual(repository.errors, ["WECOM_DELIVERY_AMBIGUOUS"]);
  assert.equal(repository.state, "AMBIGUOUS");
});
