import assert from "node:assert/strict";
import test from "node:test";

import { WecomClient } from "./wecom.client.ts";

const webhook = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=01234567-secret";

test("sends one markdown request to the exact official WeCom webhook", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ errcode: 0, errmsg: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  const client = new WecomClient({ webhookUrl: webhook, fetch: fetcher, attempts: 1 });

  await client.sendMarkdown("### 一次运行汇总");

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, webhook);
  assert.equal(requests[0]?.init.method, "POST");
  assert.deepEqual(JSON.parse(String(requests[0]?.init.body)), {
    msgtype: "markdown",
    markdown: { content: "### 一次运行汇总" }
  });
});
for (const invalid of [
  "http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secret",
  "https://qyapi.weixin.qq.com.evil.test/cgi-bin/webhook/send?key=secret",
  "https://user:password@qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secret",
  "https://qyapi.weixin.qq.com/cgi-bin/webhook/other?key=secret",
  "https://qyapi.weixin.qq.com/cgi-bin/webhook/send",
  "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secret&next=https://evil.test"
]) {
  test(`rejects non-official or credential-bearing webhook ${invalid}`, () => {
    assert.throws(
      () => new WecomClient({ webhookUrl: invalid, fetch: (() => undefined) as never }),
      (error) => error instanceof TypeError
        && error.message === "企业微信 Webhook 地址无效"
        && !error.message.includes(invalid)
    );
  });
}

test("retries with one logical message and returns only a sanitized failure", async () => {
  const requestBodies: string[] = [];
  const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
    requestBodies.push(String(init?.body));
    return new Response(JSON.stringify({
      errcode: 40001,
      errmsg: `bad webhook ${webhook}; body=${String(init?.body)}`
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  const client = new WecomClient({ webhookUrl: webhook, fetch: fetcher, attempts: 2 });

  await assert.rejects(
    () => client.sendMarkdown("private request content"),
    (error) => error instanceof Error
      && error.message === "企业微信通知发送失败"
      && !error.message.includes("01234567-secret")
      && !error.message.includes("private request content")
  );
  assert.equal(requestBodies.length, 2);
  assert.equal(requestBodies[0], requestBodies[1]);
});
