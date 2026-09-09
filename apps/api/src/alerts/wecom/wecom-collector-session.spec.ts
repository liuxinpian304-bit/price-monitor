import assert from "node:assert/strict";
import test from "node:test";

import { buildWecomCollectorSessionMessage } from "./wecom-collector-session.ts";

test("builds a WeCom markdown alert for an expired Taobao login", () => {
  const message = buildWecomCollectorSessionMessage({
    agentName: "固定采集 Mac",
    state: "LOGIN_REQUIRED",
    openedAt: "2026-09-09T01:30:00.000Z"
  });

  assert.equal(message.msgtype, "markdown");
  assert.equal(message.markdown.content, [
    "### 淘宝采集已暂停",
    "> 固定采集设备：固定采集 Mac",
    "> 原因：淘宝登录已失效",
    "> 发现时间：2026-09-09 09:30:00",
    "> 请只在固定 Mac 上恢复一次淘宝登录",
    "> 系统确认登录恢复后会自动续跑"
  ].join("\n"));
});

test("distinguishes a Taobao platform challenge from an expired login", () => {
  const content = buildWecomCollectorSessionMessage({
    agentName: "固定采集 Mac",
    state: "CHALLENGE_REQUIRED",
    openedAt: "2026-09-09T01:30:00.000Z"
  }).markdown.content;

  assert.match(content, /> 原因：淘宝触发平台验证/);
  assert.match(content, /> 处理：请先在固定 Mac 上完成人工验证/);
  assert.match(content, /> 请只在固定 Mac 上恢复一次淘宝登录/);
  assert.doesNotMatch(content, /淘宝登录已失效/);
});

test("sanitizes untrusted agent names without exposing sensitive material", () => {
  const content = buildWecomCollectorSessionMessage({
    agentName: "办公机\n### cookie=abc token=def authorization=ghi webhook=https://secret.example 二维码",
    state: "LOGIN_REQUIRED",
    openedAt: "2026-09-09T01:30:00.000Z"
  }).markdown.content;

  assert.match(content, /> 固定采集设备：固定采集设备/);
  assert.equal(/cookie|token|authorization|webhook|二维码/i.test(content), false);
  assert.equal(/abc|def|ghi|secret\.example/i.test(content), false);
  assert.equal(content.split("\n").length, 6);
});

test("neutralizes WeCom markdown control characters in a safe agent name", () => {
  const content = buildWecomCollectorSessionMessage({
    agentName: "<主机>[固定]*Mac*",
    state: "LOGIN_REQUIRED",
    openedAt: "2026-09-09T01:30:00.000Z"
  }).markdown.content;

  assert.match(content, /> 固定采集设备：＜主机＞［固定］＊Mac＊/);
  assert.doesNotMatch(content, /<主机>|\[固定\]|\*Mac\*/);
});
