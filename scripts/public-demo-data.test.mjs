import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import test from "node:test";
import { inflateRawSync } from "node:zlib";

const WORKBOOK_PATH = "outputs/tmall-price-monitor/天猫比价监控_运营录入模板.xlsx";
const TEXT_PATHS = [
  "apps/api/src/database/seed-demo.ts",
  "apps/web/src/data/demo-data.ts",
  "apps/web/src/data/api-fallbacks.ts",
];
const FIXTURE_DIRECTORY = "tests/fixtures/providers";
const DOCS_DIRECTORY = "docs";

// One-way fingerprints prevent the regression test itself from publishing legacy demo values.
const LEGACY_FINGERPRINTS = {
  employee: new Set([
    "1d841bc0ee98309cb7916670b7f0fdef5f4c35150711a41405ef3633b56322cf",
    "808b4f6221599eee052ba9c7a1a1c6374b96bb1a5f172f305dcd19bc8b7bc9a8",
    "c68e0104467c43da961532f1d8daa445021a2dfd3933eb2e7826463a3ece2050",
  ]),
  "competitor shop": new Set([
    "2cabd4b4f1750c0c0b446dad6e1895d25b218a41c173cd25b735d4326ae91a40",
    "8d8795132242f87b3acee3871598bfc061e6e7c3e8bb1db841a0bedff322b05d",
    "513cb84d8038c1d4dfadcbdbb3d9ab01e9b05ae61481ed021d7776332b00047d",
    "dce7d6eeaf45f7d92746d25e5c8f4ea79d421073736e20b676f8c6b515081a47",
    "8ddfa6ff1d1b8b26f5c9bc2d2353f4dd9767d22bb936a1a2510da6f237136b5b",
    "5c3b1202bc467a599d9e4ecf6db1b0d8522006b7084c0cc2d965ae9bf1305aea",
  ]),
  "product or evidence domain": new Set([
    "be013a9e5c3268456b61952367d5bf15bee775cf53e52eaaad8069079ca0a672",
    "2e1149d25c36bc822a9b48acea22e6e21cbdb6bc97c84d0cef38dafe3754e218",
  ]),
};

function fingerprint(value) {
  return createHash("sha256").update(value).digest("hex");
}

function reportIfLegacyValue(issues, path, category, value) {
  if (LEGACY_FINGERPRINTS[category].has(fingerprint(value))) {
    issues.add(`${path}: ${category}`);
  }
}

function inspectText(path, content, issues) {
  for (const run of content.matchAll(/[\u3400-\u9fff]{2,}/g)) {
    for (let start = 0; start < run[0].length; start += 1) {
      for (let end = start + 2; end <= run[0].length; end += 1) {
        const fragment = run[0].slice(start, end);
        reportIfLegacyValue(issues, path, "employee", fragment);
        reportIfLegacyValue(issues, path, "competitor shop", fragment);
      }
    }
  }

  for (const match of content.matchAll(/https?:\/\/([^/\s"'`]+)/g)) {
    reportIfLegacyValue(issues, path, "product or evidence domain", match[1]);
  }
}

async function filesUnder(directory, extension) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await filesUnder(path, extension));
    } else if (extname(entry.name) === extension) {
      files.push(path);
    }
  }

  return files;
}

function readZipEntries(buffer) {
  const endOfCentralDirectory = buffer.lastIndexOf(Buffer.from("PK\x05\x06"));
  assert.notEqual(endOfCentralDirectory, -1, "workbook must be a ZIP archive");

  const entryCount = buffer.readUInt16LE(endOfCentralDirectory + 10);
  let offset = buffer.readUInt32LE(endOfCentralDirectory + 16);
  const entries = new Map();

  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, "invalid ZIP directory entry");
    const compression = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");

    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, "invalid ZIP local entry");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(dataOffset, dataOffset + compressedSize);
    entries.set(name, compression === 0 ? data : inflateRawSync(data));

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function decodeXmlText(value) {
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");
}

function workbookStrings(entries) {
  const strings = [];
  for (const [path, content] of entries) {
    if (path === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(path)) {
      for (const match of content.toString("utf8").matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) {
        strings.push(decodeXmlText(match[1]));
      }
    }
  }
  return strings;
}

test("public demo artifacts do not contain legacy personal, competitor, or product data", async () => {
  const root = process.cwd();
  const issues = new Set();
  const textFiles = [
    ...TEXT_PATHS.map((path) => resolve(root, path)),
    ...await filesUnder(resolve(root, FIXTURE_DIRECTORY), ".json"),
    ...await filesUnder(resolve(root, DOCS_DIRECTORY), ".md"),
  ];

  for (const file of textFiles) {
    inspectText(relative(root, file), await readFile(file, "utf8"), issues);
  }

  const workbookPath = resolve(root, WORKBOOK_PATH);
  for (const value of workbookStrings(readZipEntries(await readFile(workbookPath)))) {
    inspectText(WORKBOOK_PATH, value, issues);
  }

  assert.deepEqual([...issues].sort(), []);
});
