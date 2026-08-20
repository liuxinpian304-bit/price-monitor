import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

function section(content, heading, nextHeading) {
  const start = content.indexOf(heading);
  const end = nextHeading ? content.indexOf(nextHeading, start) : content.length;

  assert.notEqual(start, -1, `Missing section: ${heading}`);
  assert.notEqual(end, -1, `Missing following section: ${nextHeading}`);
  return content.slice(start, end);
}

function runCommands(job) {
  return Array.from(job.matchAll(/^\s*-\s+run:\s+([^\r\n]+)\s*$/gm), (match) => match[1]);
}

function assertRunCommands(job, commands) {
  assert.deepEqual(runCommands(job), commands);
}

test("public README states the product boundary, supported platforms, and provider limit", async () => {
  const readme = await read("README.md");

  assert.match(readme, /^# 比价工具$/m);
  assert.match(readme, /只监控、提醒和记录，不自动修改(?:电商平台|天猫)?价格/);
  assert.match(readme, /docs\/operations\/windows-setup\.md/);
  assert.match(readme, /docs\/operations\/macos-setup\.md/);
  const quickStart = section(readme, "## 快速启动", "## 测试");
  const quickStartCommands = quickStart.match(/```bash\n([\s\S]*?)\n```/);

  assert.ok(quickStartCommands, "Quick start must include a shell command block.");
  assert.equal(quickStartCommands[1], [
    "pnpm install",
    "pnpm setup",
    "pnpm infra:up",
    "pnpm db:generate",
    "pnpm db:migrate",
    "pnpm seed:demo"
  ].join("\n"));
  assert.match(readme, /pnpm dev:api/);
  assert.match(readme, /pnpm dev:web/);
  assert.match(readme, /分别在两个(?:终端|窗口)/);
  assert.match(readme, /pnpm run doctor/);
  assert.match(readme, /pnpm 11.*(?:裸|bare).*pnpm doctor/);
  const testing = section(readme, "## 测试", "## 真实数据源边界");
  const testingCommands = testing.match(/```bash\n([\s\S]*?)\n```/);

  assert.ok(testingCommands, "Testing must include a shell command block.");
  assert.equal(testingCommands[1], [
    "pnpm setup",
    "pnpm db:generate",
    "pnpm verify:portable"
  ].join("\n"));
  assert.match(readme, /CommerceProvider/);
  assert.match(readme, /合规/);
  assert.match(readme, /固定样例|fixtures/);
  assert.match(readme, /手工/);
  assert.match(readme, /当前公开版不会自动执行定时采集，也不会自动发送企业微信消息/);
  assert.match(readme, /CollectionScheduler/);
  assert.match(readme, /WecomClient/);
  assert.doesNotMatch(readme, /!\[[^\]]*\]\([^)]*\.(?:png|jpe?g|webp)\)/i);
  assert.match(readme, /不附(?:开源)?许可证|暂无许可证/);
});

test("operations guides distinguish the current prototype from the production target", async () => {
  const [deploymentGuide, operatorGuide, collectorRecovery] = await Promise.all([
    read("docs/operations/deployment-guide.md"),
    read("docs/operations/operator-guide.md"),
    read("docs/operations/collector-recovery.md")
  ]);

  assert.match(deploymentGuide, /目标态/);
  assert.match(deploymentGuide, /当前公开版尚未装配.*CollectionScheduler.*Worker.*WecomClient/s);
  assert.match(operatorGuide, /目标态/);
  assert.match(operatorGuide, /当前公开版不会自动执行定时采集，也不会自动发送企业微信消息/);
  assert.match(collectorRecovery, /目标态/);
  assert.match(collectorRecovery, /当前公开版尚未装配.*Worker.*CollectionScheduler/s);
  assert.doesNotMatch(collectorRecovery, /当前版本不自动补齐/);
});

test("platform setup guides and security policy use the public release conventions", async () => {
  const [windowsGuide, macosGuide, security] = await Promise.all([
    read("docs/operations/windows-setup.md"),
    read("docs/operations/macos-setup.md"),
    read("SECURITY.md")
  ]);

  assert.match(windowsGuide, /PowerShell/);
  assert.match(windowsGuide, /pnpm run doctor/);
  assert.match(macosGuide, /Terminal/);
  assert.match(macosGuide, /pnpm run doctor/);
  assert.match(security, /GitHub/);
  assert.match(security, /private|私密/i);
  assert.doesNotMatch(security, /@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
});

test("CI verifies portable platforms and the Linux integration environment", async () => {
  const workflow = await read(".github/workflows/ci.yml");
  const portable = section(workflow, "  portable:\n", "  integration:\n");
  const integration = section(workflow, "  integration:\n");

  assert.match(portable, /os: \[ubuntu-latest, macos-latest, windows-latest\]/);
  assert.match(portable, /node-version:\s*["']?22["']?/);
  assert.match(portable, /version:\s*["']?11\.19\.0["']?/);
  assert.match(portable, /DATABASE_URL: ["']?postgresql:\/\/placeholder:placeholder@127\.0\.0\.1:5433\/price_monitor\?schema=public["']?/);
  assertRunCommands(portable, [
    "pnpm install --frozen-lockfile",
    "pnpm db:generate",
    "pnpm verify:portable"
  ]);

  assert.match(integration, /needs: portable/);
  assert.match(integration, /image: postgres:16(?:-alpine)?/);
  assert.match(integration, /image: redis:7(?:-alpine)?/);
  assert.match(integration, /- 5433:5432/);
  assert.match(integration, /- 6380:6379/);
  assert.match(integration, /DATABASE_URL: postgresql:\/\/price_monitor:price_monitor_dev@127\.0\.0\.1:5433\/price_monitor\?schema=public/);
  assert.match(integration, /REDIS_HOST: 127\.0\.0\.1/);
  assert.match(integration, /REDIS_PORT: 6380/);
  assert.match(integration, /SETTINGS_MASTER_KEY: placeholder-ci-master-key/);
  assertRunCommands(integration, [
    "pnpm install --frozen-lockfile",
    "pnpm db:generate",
    "pnpm db:migrate",
    "pnpm verify"
  ]);
});

test("CI integration command contract rejects portable verification", async () => {
  const workflow = await read(".github/workflows/ci.yml");
  const integration = section(workflow, "  integration:\n");
  const portableIntegration = integration.replace(
    "- run: pnpm verify\n",
    "- run: pnpm verify:portable\n"
  );

  assert.notEqual(portableIntegration, integration);
  assert.throws(() => assertRunCommands(portableIntegration, [
    "pnpm install --frozen-lockfile",
    "pnpm db:generate",
    "pnpm db:migrate",
    "pnpm verify"
  ]));
});
