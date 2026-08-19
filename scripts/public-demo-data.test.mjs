import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import test from "node:test";
import { inflateRawSync } from "node:zlib";

import { alerts, comparisons, models } from "../apps/web/src/data/demo-data.ts";
import {
  fallbackAlerts,
  fallbackCatalog,
  fallbackComparisons,
  fallbackHistory,
  fallbackManualCandidates,
} from "../apps/web/src/data/api-fallbacks.ts";

const WORKBOOK_PATH = "outputs/tmall-price-monitor/天猫比价监控_运营录入模板.xlsx";
const TEXT_PATHS = [
  "apps/api/src/database/seed-demo.ts",
  "apps/web/src/data/demo-data.ts",
  "apps/web/src/data/api-fallbacks.ts",
];
const FIXTURE_DIRECTORY = "tests/fixtures/providers";
const DOCS_DIRECTORY = "docs";
const ALLOWED_OWNERS = new Set(["运营A", "运营B", "运营C"]);
const ALLOWED_COMPETITOR_SHOPS = new Set(["示例同行店A", "示例同行店B", "示例同行店C"]);

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

function inspectText(path, content, issues, enforcePublicUrl = false) {
  for (const run of content.matchAll(/[\u3400-\u9fff]{2,}/g)) {
    for (let start = 0; start < run[0].length; start += 1) {
      for (let end = start + 2; end <= run[0].length; end += 1) {
        const fragment = run[0].slice(start, end);
        reportIfLegacyValue(issues, path, "employee", fragment);
        reportIfLegacyValue(issues, path, "competitor shop", fragment);
      }
    }
  }

  for (const match of content.matchAll(/https?:\/\/[^\s"'`<>]+/g)) {
    let hostname = "";
    try {
      hostname = new URL(match[0]).hostname;
    } catch {
      // The public URL contract below reports malformed URLs without exposing them.
    }
    reportIfLegacyValue(issues, path, "product or evidence domain", hostname);
    if (enforcePublicUrl && !isPublicDemoUrl(match[0])) issues.add(`${path}: public URL`);
  }

  for (const match of content.matchAll(/\bowner\s*:\s*["']([^"']+)["']/g)) {
    if (!ALLOWED_OWNERS.has(match[1])) issues.add(`${path}: owner`);
  }
  for (const match of content.matchAll(/\bcompetitorShop\s*:\s*["']([^"']+)["']/g)) {
    if (!ALLOWED_COMPETITOR_SHOPS.has(match[1])) issues.add(`${path}: competitor shop`);
  }

  for (const match of content.matchAll(/运营[A-Z]/g)) {
    if (!ALLOWED_OWNERS.has(match[0])) issues.add(`${path}: owner`);
  }
  for (const match of content.matchAll(/示例同行店[A-Z]/g)) {
    if (!ALLOWED_COMPETITOR_SHOPS.has(match[0])) issues.add(`${path}: competitor shop`);
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

function workbookSharedStrings(entries) {
  const tag = "(?:[A-Za-z_][\\w.-]*:)?";
  const textNodes = (xml) => [...xml.matchAll(new RegExp(`<${tag}t(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}t>`, "g"))]
    .map((match) => decodeXmlText(match[1]));
  const sharedStrings = [];

  const sharedXml = entries.get("xl/sharedStrings.xml")?.toString("utf8");
  if (sharedXml) {
    for (const match of sharedXml.matchAll(new RegExp(`<${tag}si(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}si>`, "g"))) {
      sharedStrings.push(textNodes(match[1]).join(""));
    }
  }

  return { sharedStrings, tag, textNodes };
}

function workbookCells(entries) {
  const { sharedStrings, tag, textNodes } = workbookSharedStrings(entries);
  const cells = [];

  for (const [path, content] of entries) {
    const xml = content.toString("utf8");
    if (/^xl\/worksheets\/sheet\d+\.xml$/.test(path)) {
      for (const cell of xml.matchAll(new RegExp(`<${tag}c\\b([^>]*)>([\\s\\S]*?)<\\/${tag}c>`, "g"))) {
        const reference = /\br=["']([^"']+)["']/.exec(cell[1])?.[1];
        const cellType = /\bt=["']([^"']+)["']/.exec(cell[1])?.[1];
        const body = cell[2];
        let value;
        if (cellType === "s") {
          const sharedIndex = new RegExp(`<${tag}v(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}v>`).exec(body)?.[1];
          const shared = sharedStrings[Number(sharedIndex)];
          if (shared !== undefined) value = shared;
        } else if (cellType === "str") {
          const formulaValue = new RegExp(`<${tag}v(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}v>`).exec(body)?.[1];
          if (formulaValue !== undefined) value = decodeXmlText(formulaValue);
        } else if (cellType === "inlineStr") {
          value = textNodes(body).join("");
        }
        if (reference && value !== undefined) cells.push({ path, reference, value });
      }
    }
  }

  return cells;
}

function workbookStrings(entries) {
  const strings = workbookCells(entries).map((cell) => cell.value);
  const { tag } = workbookSharedStrings(entries);

  for (const [path, content] of entries) {
    const xml = content.toString("utf8");
    if (/^xl\/worksheets\/sheet\d+\.xml$/.test(path)) {
      for (const cell of xml.matchAll(new RegExp(`<${tag}c\\b[^>]*>([\\s\\S]*?)<\\/${tag}c>`, "g"))) {
        for (const formula of cell[1].matchAll(new RegExp(`<${tag}f(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}f>`, "g"))) {
          strings.push(decodeXmlText(formula[1]));
        }
      }
    }
    if (/^xl\/.*\.rels$/.test(path)) {
      for (const relationship of xml.matchAll(/<(?:(?:[A-Za-z_][\w.-]*:)?Relationship)\b[^>]*\bTarget=["']([^"']+)["'][^>]*\/?>(?:<\/(?:[A-Za-z_][\w.-]*:)?Relationship>)?/g)) {
        strings.push(decodeXmlText(relationship[1]));
      }
    }
  }
  return strings;
}

function workbookOwnerIssues(path, entries) {
  const issues = new Set();
  const headers = new Map();

  for (const cell of workbookCells(entries)) {
    const match = /^([A-Z]+)(\d+)$/.exec(cell.reference);
    if (!match || cell.value !== "负责人") continue;
    headers.set(`${cell.path}:${match[1]}`, Number(match[2]));
  }

  for (const cell of workbookCells(entries)) {
    const match = /^([A-Z]+)(\d+)$/.exec(cell.reference);
    if (!match || !cell.value.trim()) continue;
    const headerRow = headers.get(`${cell.path}:${match[1]}`);
    if (headerRow !== undefined && Number(match[2]) > headerRow && !ALLOWED_OWNERS.has(cell.value.trim())) {
      issues.add(`${path}: owner`);
    }
  }

  return issues;
}

function isPublicDemoUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "example.com" && url.pathname !== "/";
  } catch {
    return false;
  }
}

function collectStructuredIssues(path, records) {
  const issues = new Set();
  const report = (category) => issues.add(`${path}: ${category}`);

  for (const record of records) {
    if (record.owner && !ALLOWED_OWNERS.has(record.owner)) report("owner");
    if (record.shop && !ALLOWED_COMPETITOR_SHOPS.has(record.shop)) report("competitor shop");
    if (record.url && !isPublicDemoUrl(record.url)) report("public URL");
  }

  return issues;
}

function collectPriceConsistencyIssues(seedPairs) {
  const issues = new Set();
  const report = (path, category) => issues.add(`${path}: ${category}`);
  const pairKey = (ownPriceFen, competitorPriceFen) => `${ownPriceFen}:${competitorPriceFen}`;
  const alertPairs = new Map(alerts.map((alert) => [alert.monitorCode, pairKey(alert.ownPriceFen, alert.competitorPriceFen)]));
  const comparisonPairs = new Map(comparisons.map((comparison) => [comparison.monitorCode, pairKey(comparison.own, comparison.competitor)]));

  for (const alert of alerts) {
    if (alert.competitorPriceFen >= alert.ownPriceFen) report("apps/web/src/data/demo-data.ts", "alert price relationship");
    if (!alert.monitorCode || alertPairs.get(alert.monitorCode) !== seedPairs.get(alert.monitorCode)) {
      report("apps/web/src/data/demo-data.ts", "seed snapshot price pair");
    }
  }

  for (const comparison of comparisons) {
    if (comparison.competitor >= comparison.own) report("apps/web/src/data/demo-data.ts", "comparison price relationship");
    if (!comparison.monitorCode || comparisonPairs.get(comparison.monitorCode) !== seedPairs.get(comparison.monitorCode)) {
      report("apps/web/src/data/demo-data.ts", "seed snapshot price pair");
    }
    const matchingAlert = alerts.find((alert) =>
      alert.model === comparison.model && alert.foundAt.slice(11) === comparison.updated
    );
    if (matchingAlert && pairKey(matchingAlert.ownPriceFen, matchingAlert.competitorPriceFen) !== pairKey(comparison.own, comparison.competitor)) {
      report("apps/web/src/data/demo-data.ts", "cross-view snapshot price pair");
    }
  }

  for (const alert of fallbackAlerts) {
    if (pairKey(alert.ownPriceFen, alert.competitorPriceFen) !== alertPairs.get(alert.monitorCode)) {
      report("apps/web/src/data/api-fallbacks.ts", "alert snapshot price pair");
    }
  }
  for (const comparison of fallbackComparisons) {
    if (pairKey(comparison.ownPriceFen, comparison.competitorPriceFen) !== comparisonPairs.get(comparison.monitorCode)) {
      report("apps/web/src/data/api-fallbacks.ts", "comparison snapshot price pair");
    }
  }

  return issues;
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
    inspectText(
      relative(root, file),
      await readFile(file, "utf8"),
      issues,
      !file.startsWith(resolve(root, DOCS_DIRECTORY))
    );
  }

  const workbookPath = resolve(root, WORKBOOK_PATH);
  const workbookEntries = readZipEntries(await readFile(workbookPath));
  for (const value of workbookStrings(workbookEntries)) {
    inspectText(WORKBOOK_PATH, value, issues, true);
  }
  for (const issue of workbookOwnerIssues(WORKBOOK_PATH, workbookEntries)) issues.add(issue);

  assert.deepEqual([...issues].sort(), []);
});

test("extracts every XLSX string representation before applying privacy checks", () => {
  const restrictedOwner = "运营D";
  const restrictedUrl = "http://example.com/private";
  const entries = new Map([
    ["xl/sharedStrings.xml", Buffer.from(`<x:sst xmlns:x="urn:test"><x:si><x:t>${restrictedOwner}</x:t></x:si></x:sst>`)],
    ["xl/worksheets/sheet1.xml", Buffer.from(`<x:worksheet xmlns:x="urn:test"><x:sheetData><x:row><x:c r="A1" t="str"><x:v>${restrictedOwner}</x:v></x:c><x:c r="B1" t="s"><x:v>0</x:v></x:c><x:c r="C1" t="inlineStr"><x:is><x:t>${restrictedOwner}</x:t></x:is></x:c><x:c r="D1"><x:f>CONCAT(&quot;${restrictedOwner}&quot;)</x:f></x:c></x:row></x:sheetData></x:worksheet>`)],
    ["xl/worksheets/_rels/sheet1.xml.rels", Buffer.from(`<Relationships xmlns="urn:test"><Relationship Target="${restrictedUrl}" /></Relationships>`)],
  ]);

  const values = workbookStrings(entries);
  assert.equal(values.filter((value) => value.includes(restrictedOwner)).length, 4);
  assert.equal(values.filter((value) => value.includes(restrictedUrl)).length, 1);
  const issues = new Set();
  for (const value of values) inspectText("synthetic.xlsx", value, issues, true);
  assert.deepEqual([...issues].sort(), ["synthetic.xlsx: owner", "synthetic.xlsx: public URL"]);
});

test("rejects nonallowlisted seed literals and non-HTTPS demo URLs without echoing values", () => {
  const issues = new Set();
  inspectText(
    "synthetic-seed.ts",
    'const record = { owner: "任意人员", competitorShop: "不相关店铺", productUrl: "http://example.com/demo" };',
    issues,
    true
  );

  assert.deepEqual([...issues].sort(), [
    "synthetic-seed.ts: competitor shop",
    "synthetic-seed.ts: owner",
    "synthetic-seed.ts: public URL",
  ]);
});

test("requires each non-empty owner below a 负责人 workbook header to be allowlisted", () => {
  const entries = new Map([
    ["xl/worksheets/sheet1.xml", Buffer.from(`<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>负责人</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>任意人员</t></is></c></row></sheetData></worksheet>`)],
  ]);
  const issues = new Set();

  for (const issue of workbookOwnerIssues("synthetic-owner.xlsx", entries)) issues.add(issue);

  assert.deepEqual([...issues].sort(), ["synthetic-owner.xlsx: owner"]);
});

test("enforces public owner, shop, and URL allowlists without echoing rejected values", async () => {
  const issues = new Set([
    ...collectStructuredIssues("apps/web/src/data/demo-data.ts", [
      ...alerts.map((alert) => ({ owner: alert.owner, shop: alert.competitorShop, url: alert.competitorUrl })),
      ...models.map((model) => ({ owner: model.owner })),
      ...comparisons.map((comparison) => ({ shop: comparison.shop })),
    ]),
    ...collectStructuredIssues("apps/web/src/data/api-fallbacks.ts", [
      ...fallbackAlerts.map((alert) => ({ owner: alert.owner, shop: alert.competitorShop, url: alert.competitorUrl })),
      ...fallbackCatalog.map((model) => ({ owner: model.owner, url: model.ownUrl })),
      ...fallbackComparisons.map((comparison) => ({ shop: comparison.competitorShop, url: comparison.competitorUrl })),
      ...fallbackHistory.map((entry) => ({ shop: entry.shop, url: entry.evidenceUrl })),
      ...fallbackManualCandidates.map((candidate) => ({ shop: candidate.shop, url: candidate.url })),
    ]),
  ]);

  for (const file of await filesUnder(resolve("tests/fixtures/providers"), ".json")) {
    const fixture = JSON.parse(await readFile(file, "utf8"));
    const records = fixture.data?.items ?? [fixture.data].filter(Boolean);
    for (const issue of collectStructuredIssues(relative(process.cwd(), file), records.map((record) => ({
      shop: record.shop_name,
      url: record.url,
    })))) {
      issues.add(issue);
    }
    if (fixture.data?.evidence_url) {
      for (const issue of collectStructuredIssues(relative(process.cwd(), file), [{ url: fixture.data.evidence_url }])) {
        issues.add(issue);
      }
    }
  }

  assert.deepEqual([...issues].sort(), []);
  assert.deepEqual(
    [...collectStructuredIssues("synthetic.json", [{ owner: "运营D", shop: "示例同行店D", url: "https://not-example.invalid/private" }])].sort(),
    ["synthetic.json: competitor shop", "synthetic.json: owner", "synthetic.json: public URL"]
  );
});

test("uses one fictional lower price pair for each demo snapshot", async () => {
  const source = await readFile("apps/api/src/database/seed-demo.ts", "utf8");
  const seedPairs = new Map([...source.matchAll(/monitorCode:\s*"(MON-\d+)"[\s\S]*?ownPriceFen:\s*(\d[\d_]*)[\s\S]*?competitorPriceFen:\s*(\d[\d_]*)/g)]
    .map((match) => [match[1], `${Number(match[2].replaceAll("_", ""))}:${Number(match[3].replaceAll("_", ""))}`]));

  assert.deepEqual([...collectPriceConsistencyIssues(seedPairs)].sort(), []);
});
