import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const TEMPLATE_PATH = "outputs/tmall-price-monitor/天猫比价监控_运营录入模板.xlsx";
const BINARY_EXTENSIONS = new Set([".jpeg", ".jpg", ".png", ".webp", ".xlsx", ".zip"]);
const RECORDING_EXTENSIONS = new Set([".aac", ".flac", ".m4a", ".mp3", ".ogg", ".wav"]);
const PLACEHOLDER_SECRET = "replace-with-a-long-random-secret";

function isPlaceholder(value) {
  return value === PLACEHOLDER_SECRET
    || /^(?:demo|example|fake|placeholder|replace|test|your)[-_]/i.test(value)
    || value.startsWith("<");
}

function normalizePath(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function pathIssue(path) {
  const normalized = normalizePath(path);
  const segments = normalized.split("/");
  const name = segments.at(-1);

  if (segments.includes(".git")) {
    return "disallowed Git metadata";
  }

  if (name.startsWith(".env") && name !== ".env.example") {
    return "disallowed environment file";
  }

  if (segments.includes("node_modules")) {
    return "disallowed dependency path";
  }

  if (segments.some((segment, index) => segment === "generated" && segments[index + 1] === "prisma")) {
    return "disallowed generated Prisma path";
  }

  if (normalized === "work" || normalized.startsWith("work/")) {
    return "disallowed local work path";
  }

  if (normalized === "tmp" || normalized.startsWith("tmp/")) {
    return "disallowed temporary path";
  }

  if (extname(name).toLowerCase() === ".zip") {
    return "disallowed archive";
  }

  if (RECORDING_EXTENSIONS.has(extname(name).toLowerCase()) || /(?:录音|recording)/i.test(name)) {
    return "disallowed recording";
  }

  if (segments.some((segment) => /(?:销售|sales)/i.test(segment))) {
    return "disallowed sales file";
  }

  if (normalized === "outputs" || normalized.startsWith("outputs/")) {
    if (normalized !== TEMPLATE_PATH) {
      return "disallowed output file";
    }
  }

  if (BINARY_EXTENSIONS.has(extname(name).toLowerCase()) && normalized !== TEMPLATE_PATH) {
    return "disallowed unreviewed binary asset";
  }

  return null;
}

export function auditPaths(paths) {
  return paths.flatMap((path) => {
    const issue = pathIssue(path);
    return issue ? [`${normalizePath(path)}: ${issue}`] : [];
  });
}

export function auditText(path, content) {
  const errors = [];
  const report = (category) => errors.push(`${normalizePath(path)}: ${category}`);

  const webhook = /https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=([^\s"'`]+)/i.exec(content);
  if (webhook && webhook[1].length >= 24 && !isPlaceholder(webhook[1])) {
    report("possible webhook secret");
  }

  const secretPattern = /(?:^|[\s"'`])(?:[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|API_KEY|MASTER_KEY)[A-Z0-9_]*)\s*(?:=|:)\s*["']?([A-Za-z0-9][^\s"'`,;]*)/gm;
  for (const match of content.matchAll(secretPattern)) {
    if (!isPlaceholder(match[1])) {
      report("possible secret");
    }
  }

  for (const _match of content.matchAll(/(?:\/Users\/[^\s"'`]+|[A-Za-z]:[\\/]+Users[\\/]+[^\s"'`]+)/g)) {
    report("local filesystem path");
  }

  return errors;
}

function isBinary(path, content) {
  return BINARY_EXTENSIONS.has(extname(path).toLowerCase()) || content.includes(0);
}

export async function auditTrackedFiles(cwd = process.cwd()) {
  const git = spawnSync("git", ["ls-files", "-z"], { cwd, encoding: null });

  if (git.status !== 0 || git.error) {
    throw new Error("Unable to list Git-tracked files.");
  }

  const paths = git.stdout.toString("utf8").split("\0").filter(Boolean);
  const errors = auditPaths(paths);

  for (const path of paths) {
    if (pathIssue(path)) {
      continue;
    }

    try {
      const content = await readFile(resolve(cwd, path));
      if (!isBinary(path, content)) {
        errors.push(...auditText(path, content.toString("utf8")));
      }
    } catch {
      errors.push(`${normalizePath(path)}: unreadable tracked file`);
    }
  }

  return errors;
}

async function main() {
  const errors = await auditTrackedFiles();

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }
    process.exitCode = 1;
    return;
  }

  console.log("Public repository audit passed.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
