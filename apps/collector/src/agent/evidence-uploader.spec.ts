import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  EvidenceUploadError,
  EvidenceUploader,
  type EvidenceUploadApi
} from "./evidence-uploader.ts";

const pngBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);

function keyFor(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

class FakeEvidenceApi implements EvidenceUploadApi {
  calls: Array<{ runId: string; evidenceKey: string; bytes: Uint8Array }> = [];
  acknowledgements: string[] = [];
  failure: Error | null = null;

  async uploadEvidence(runId: string, evidenceKey: string, bytes: Uint8Array) {
    this.calls.push({ runId, evidenceKey, bytes });
    if (this.failure) throw this.failure;
    return { evidenceKey: this.acknowledgements.shift() ?? evidenceKey };
  }
}

async function fixture() {
  const workRoot = await mkdtemp(join(tmpdir(), "collector-evidence-uploader-"));
  const runDirectory = join(workRoot, "run-1");
  await mkdir(runDirectory);
  const evidencePath = join(runDirectory, "capture.png");
  await writeFile(evidencePath, pngBytes);
  return { workRoot, runDirectory, evidencePath, evidenceKey: keyFor(pngBytes) };
}

test("uploads each evidence hash once from its validated run directory", async () => {
  const { workRoot, evidencePath, evidenceKey } = await fixture();
  const api = new FakeEvidenceApi();
  const uploader = new EvidenceUploader(api, workRoot);

  assert.deepEqual(await uploader.upload("run-1", { [evidenceKey]: evidencePath }), {
    uploadedCount: 1,
    totalCount: 1
  });
  assert.deepEqual(await uploader.upload("run-1", { [evidenceKey]: evidencePath }), {
    uploadedCount: 1,
    totalCount: 1
  });
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0]?.runId, "run-1");
  assert.equal(api.calls[0]?.evidenceKey, evidenceKey);
  assert.deepEqual(api.calls[0]?.bytes, pngBytes);
});

test("does not mark a hash uploaded until the API acknowledges the same hash", async () => {
  const { workRoot, evidencePath, evidenceKey } = await fixture();
  const api = new FakeEvidenceApi();
  const uploader = new EvidenceUploader(api, workRoot);
  api.acknowledgements.push(`sha256:${"f".repeat(64)}`);

  await assert.rejects(
    () => uploader.upload("run-1", { [evidenceKey]: evidencePath }),
    (error: unknown) => error instanceof EvidenceUploadError && error.code === "ACKNOWLEDGEMENT_MISMATCH"
  );
  assert.equal(api.calls.length, 1);

  await uploader.upload("run-1", { [evidenceKey]: evidencePath });
  assert.equal(api.calls.length, 2);
});

test("retains earlier acknowledgements when a later evidence upload fails", async () => {
  const { workRoot, runDirectory, evidencePath, evidenceKey } = await fixture();
  const secondBytes = Uint8Array.from([...pngBytes, 4]);
  const secondKey = keyFor(secondBytes);
  const secondPath = join(runDirectory, "second.png");
  await writeFile(secondPath, secondBytes);
  let calls = 0;
  const api: EvidenceUploadApi = {
    async uploadEvidence(_runId, key) {
      calls += 1;
      if (key === secondKey && calls === 2) throw new Error("transient");
      return { evidenceKey: key };
    }
  };
  const uploader = new EvidenceUploader(api, workRoot);
  const manifest = { [evidenceKey]: evidencePath, [secondKey]: secondPath };

  await assert.rejects(() => uploader.upload("run-1", manifest));
  await uploader.upload("run-1", manifest);

  assert.equal(calls, 3);
});

test("rejects manifest paths outside the run directory without reading or uploading them", async () => {
  const { workRoot, evidenceKey } = await fixture();
  const outsidePath = join(workRoot, "outside.png");
  await writeFile(outsidePath, pngBytes);
  const api = new FakeEvidenceApi();
  const uploader = new EvidenceUploader(api, workRoot);

  await assert.rejects(
    () => uploader.upload("run-1", { [evidenceKey]: outsidePath }),
    (error: unknown) => error instanceof EvidenceUploadError && error.code === "INVALID_PATH"
  );
  assert.equal(api.calls.length, 0);
});

test("rejects a symlink escape from the run directory", { skip: process.platform === "win32" }, async () => {
  const { workRoot, runDirectory, evidenceKey } = await fixture();
  const outsidePath = join(workRoot, "outside.png");
  const linkedPath = join(runDirectory, "linked.png");
  await writeFile(outsidePath, pngBytes);
  await symlink(outsidePath, linkedPath);
  const api = new FakeEvidenceApi();
  const uploader = new EvidenceUploader(api, workRoot);

  await assert.rejects(
    () => uploader.upload("run-1", { [evidenceKey]: linkedPath }),
    (error: unknown) => error instanceof EvidenceUploadError && error.code === "INVALID_PATH"
  );
  assert.equal(api.calls.length, 0);
});

test("rejects non-PNG bytes and content that does not match the manifest hash", async () => {
  const { workRoot, runDirectory, evidencePath, evidenceKey } = await fixture();
  const api = new FakeEvidenceApi();
  const uploader = new EvidenceUploader(api, workRoot);
  const wrongKey = `sha256:${"0".repeat(64)}`;

  await assert.rejects(
    () => uploader.upload("run-1", { [wrongKey]: evidencePath }),
    (error: unknown) => error instanceof EvidenceUploadError && error.code === "HASH_MISMATCH"
  );

  const textPath = join(runDirectory, "not-png.png");
  const textBytes = new TextEncoder().encode("not a png");
  await writeFile(textPath, textBytes);
  await assert.rejects(
    () => uploader.upload("run-1", { [keyFor(textBytes)]: textPath }),
    (error: unknown) => error instanceof EvidenceUploadError && error.code === "INVALID_PNG"
  );
  assert.equal(api.calls.length, 0);
  assert.equal(JSON.stringify(new EvidenceUploadError("INVALID_PATH")).includes(evidencePath), false);
});
