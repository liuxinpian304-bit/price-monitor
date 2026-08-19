import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("public README states the product boundary, supported platforms, and provider limit", async () => {
  const readme = await read("README.md");

  assert.match(readme, /^# 比价工具$/m);
  assert.match(readme, /只监控、提醒和记录，不自动修改(?:电商平台|天猫)?价格/);
  assert.match(readme, /docs\/operations\/windows-setup\.md/);
  assert.match(readme, /docs\/operations\/macos-setup\.md/);
  assert.match(readme, /pnpm install/);
  assert.match(readme, /pnpm setup/);
  assert.match(readme, /pnpm infra:up/);
  assert.match(readme, /pnpm db:generate/);
  assert.match(readme, /pnpm db:migrate/);
  assert.match(readme, /pnpm seed:demo/);
  assert.match(readme, /pnpm dev:api/);
  assert.match(readme, /pnpm dev:web/);
  assert.match(readme, /分别在两个(?:终端|窗口)/);
  assert.match(readme, /pnpm run doctor/);
  assert.match(readme, /pnpm 11.*(?:裸|bare).*pnpm doctor/);
  assert.match(readme, /CommerceProvider/);
  assert.match(readme, /合规/);
  assert.match(readme, /固定样例|fixtures/);
  assert.match(readme, /手工/);
  assert.match(readme, /不附(?:开源)?许可证|暂无许可证/);
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

  assert.match(workflow, /node-version:\s*["']?22["']?/);
  assert.match(workflow, /version:\s*["']?11\.19\.0["']?/);
  assert.match(workflow, /ubuntu-latest/);
  assert.match(workflow, /macos-latest/);
  assert.match(workflow, /windows-latest/);
  assert.match(workflow, /postgres:16(?:-alpine)?/);
  assert.match(workflow, /redis:7(?:-alpine)?/);
  assert.match(workflow, /5433:5432/);
  assert.match(workflow, /6380:6379/);
  assert.match(workflow, /pnpm db:generate/);
  assert.match(workflow, /pnpm db:migrate/);
  assert.match(workflow, /pnpm verify:portable/);
  assert.match(workflow, /pnpm verify/);
});
