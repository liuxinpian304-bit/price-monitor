import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { auditPaths, auditText } from "./public-audit.mjs";

const templatePath = "outputs/tmall-price-monitor/天猫比价监控_运营录入模板.xlsx";

test("rejects private and non-public paths across path separators", () => {
  const errors = auditPaths([
    ".git/config",
    "repository\\.git\\HEAD",
    ".env",
    "config/.env.production",
    ".env.example",
    templatePath,
    "node_modules/package/index.js",
    "apps\\web\\node_modules\\react\\index.js",
    "generated/prisma/client.ts",
    "apps/api/generated/prisma/models.ts",
    "work/meeting-notes.md",
    "tmp/cache.db",
    "outputs/meeting-notes.md",
    "outputs/tmall-price-monitor/private-export.zip",
    "docs/design/unreviewed-dashboard.png",
    "docs/design/unreviewed-dashboard.jpg",
    "docs/design/unreviewed-dashboard.webp",
    "recordings/20260819.m4a",
    "reports/销售数据.xlsx",
    "sales/orders.csv",
    "archive\\sales\\orders.csv",
  ]);

  assert.deepEqual(errors, [
    ".git/config: disallowed Git metadata",
    "repository/.git/HEAD: disallowed Git metadata",
    ".env: disallowed environment file",
    "config/.env.production: disallowed environment file",
    "node_modules/package/index.js: disallowed dependency path",
    "apps/web/node_modules/react/index.js: disallowed dependency path",
    "generated/prisma/client.ts: disallowed generated Prisma path",
    "apps/api/generated/prisma/models.ts: disallowed generated Prisma path",
    "work/meeting-notes.md: disallowed local work path",
    "tmp/cache.db: disallowed temporary path",
    "outputs/meeting-notes.md: disallowed output file",
    "outputs/tmall-price-monitor/private-export.zip: disallowed archive",
    "docs/design/unreviewed-dashboard.png: disallowed unreviewed binary asset",
    "docs/design/unreviewed-dashboard.jpg: disallowed unreviewed binary asset",
    "docs/design/unreviewed-dashboard.webp: disallowed unreviewed binary asset",
    "recordings/20260819.m4a: disallowed recording",
    "reports/销售数据.xlsx: disallowed sales file",
    "sales/orders.csv: disallowed sales file",
    "archive/sales/orders.csv: disallowed sales file",
  ]);
});

test("redacts secret values and detects local paths in text", () => {
  const webhookSecret = "actual-wecom-webhook-secret";
  const masterKey = "non-placeholder-secret-value";
  const webhook = [
    "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key",
    webhookSecret,
  ].join("=");
  const macPath = ["", "Users", "name", "private", "project"].join("/");
  const windowsPath = ["C:", "Users", "name", "private", "project"].join("\\");
  const errors = auditText(
    "apps/config.ts",
    [
      `const webhook = \"${webhook}\";`,
      ["SETTINGS_MASTER_KEY", masterKey].join("="),
      `const macPath = \"${macPath}\";`,
      `const windowsPath = \"${windowsPath}\";`,
    ].join("\n")
  );

  assert.deepEqual(errors, [
    "apps/config.ts: possible webhook secret",
    "apps/config.ts: possible secret",
    "apps/config.ts: local filesystem path",
    "apps/config.ts: local filesystem path",
  ]);
  assert.equal(errors.join("\n").includes(webhookSecret), false);
  assert.equal(errors.join("\n").includes(masterKey), false);
  assert.deepEqual(
    auditText(".env.example", "SETTINGS_MASTER_KEY=replace-with-a-long-random-secret\n"),
    []
  );
  assert.deepEqual(
    auditText(
      "apps/config.spec.ts",
      ["https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key", "test-webhook-key"].join("=")
    ),
    []
  );
  assert.deepEqual(
    auditText(
      "apps/config.spec.ts",
      ["https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key", "fixture-key"].join("=")
    ),
    []
  );
});

test("CLI audits only Git-tracked files and never prints matched secret content", async (t) => {
  const repository = await mkdtemp(join(tmpdir(), "public-audit-"));
  const script = resolve("scripts/public-audit.mjs");
  const untrackedSecret = "untracked-secret-value";
  const trackedSecret = "tracked-secret-value";
  const secretAssignment = (value) => ["SETTINGS_MASTER_KEY", value].join("=");

  t.after(() => rm(repository, { force: true, recursive: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: repository });
  await writeFile(join(repository, "safe.txt"), "public content\n");
  await writeFile(join(repository, "untracked.txt"), `${secretAssignment(untrackedSecret)}\n`);
  execFileSync("git", ["add", "safe.txt"], { cwd: repository });

  const cleanAudit = spawnSync(process.execPath, [script], {
    cwd: repository,
    encoding: "utf8",
  });

  assert.equal(cleanAudit.status, 0);
  assert.equal(`${cleanAudit.stdout}${cleanAudit.stderr}`.includes(untrackedSecret), false);

  await writeFile(join(repository, "tracked.txt"), `${secretAssignment(trackedSecret)}\n`);
  execFileSync("git", ["add", "tracked.txt"], { cwd: repository });

  const failedAudit = spawnSync(process.execPath, [script], {
    cwd: repository,
    encoding: "utf8",
  });
  const output = `${failedAudit.stdout}${failedAudit.stderr}`;

  assert.equal(failedAudit.status, 1);
  assert.match(output, /tracked\.txt: possible secret/);
  assert.equal(output.includes(trackedSecret), false);
});
