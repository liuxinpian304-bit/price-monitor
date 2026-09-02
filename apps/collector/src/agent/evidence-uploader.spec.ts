import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, lstat, mkdtemp, mkdir, open, realpath, rename, symlink, writeFile } from "node:fs/promises";
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

test("does not mark a hash uploaded when acknowledgement times out", async () => {
  const { workRoot, evidencePath, evidenceKey } = await fixture();
  const api = new FakeEvidenceApi();
  const uploader = new EvidenceUploader(api, workRoot);
  api.failure = Object.assign(new Error("unsafe body timeout detail"), {
    code: "TIMEOUT",
    transient: true
  });

  await assert.rejects(() => uploader.upload("run-1", { [evidenceKey]: evidencePath }), {
    code: "TIMEOUT"
  });
  api.failure = null;
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

test("rejects nested and normalized manifest paths before candidate filesystem access", async () => {
  const { workRoot, runDirectory, evidenceKey } = await fixture();
  const unsafePaths = [
    join(runDirectory, "nested", "file.png"),
    "nested/file.png",
    "nested\\file.png",
    `${runDirectory}/nested/../capture.png`,
    "run-1/nested/file.png",
    "capture%2Foutside.png",
    "capture%5Coutside.png",
    "",
    ".",
    "..",
    "capture\0.png"
  ];

  for (const manifestPath of unsafePaths) {
    let candidateTouched = false;
    let openCalls = 0;
    const api = new FakeEvidenceApi();
    const uploader = new EvidenceUploader(api, workRoot, {
      fileSystem: {
        realpath,
        async lstat(path) {
          if (path.includes("nested") || path.includes("capture%")) candidateTouched = true;
          return lstat(path);
        },
        async open(path, flags) {
          openCalls += 1;
          return open(path, flags);
        }
      }
    });

    await assert.rejects(
      () => uploader.upload("run-1", { [evidenceKey]: manifestPath }),
      (error: unknown) => error instanceof EvidenceUploadError && error.code === "INVALID_PATH",
      manifestPath
    );
    assert.equal(candidateTouched, false, manifestPath);
    assert.equal(openCalls, 0, manifestPath);
    assert.equal(api.calls.length, 0, manifestPath);
  }
});

test("rejects the reviewed nested-directory replacement vector before its swap hook", {
  skip: process.platform === "win32"
}, async () => {
  const { workRoot, runDirectory } = await fixture();
  const nestedDirectory = join(runDirectory, "nested");
  const anchoredDirectory = join(runDirectory, "nested-original");
  const nestedPath = join(nestedDirectory, "file.png");
  const outsideDirectory = await mkdtemp(join(tmpdir(), "collector-nested-swap-"));
  const outsideBytes = Uint8Array.from([...pngBytes, 9]);
  await mkdir(nestedDirectory);
  await writeFile(nestedPath, pngBytes);
  await writeFile(join(outsideDirectory, "file.png"), outsideBytes);
  let nestedLstatCalls = 0;
  let swapTriggered = false;
  let openCalls = 0;
  const api = new FakeEvidenceApi();
  const uploader = new EvidenceUploader(api, workRoot, {
    fileSystem: {
      realpath,
      async lstat(path) {
        if (path.endsWith("/run-1/nested/file.png")) {
          nestedLstatCalls += 1;
          if (nestedLstatCalls === 2) {
            swapTriggered = true;
            await rename(nestedDirectory, anchoredDirectory);
            await symlink(outsideDirectory, nestedDirectory);
          }
        }
        return lstat(path);
      },
      async open(path, flags) {
        openCalls += 1;
        return open(path, flags);
      }
    }
  });

  await assert.rejects(
    () => uploader.upload("run-1", { [keyFor(outsideBytes)]: nestedPath }),
    (error: unknown) => error instanceof EvidenceUploadError && error.code === "INVALID_PATH"
  );
  assert.equal(swapTriggered, false);
  assert.equal(openCalls, 0);
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

test("rejects a symlinked run directory that physically escapes the work root", {
  skip: process.platform === "win32"
}, async () => {
  const { workRoot } = await fixture();
  const outsideRoot = await mkdtemp(join(tmpdir(), "collector-evidence-outside-"));
  const escapedRun = join(workRoot, "run-escaped");
  const escapedEvidence = join(escapedRun, "capture.png");
  await writeFile(join(outsideRoot, "capture.png"), pngBytes);
  await symlink(outsideRoot, escapedRun);
  const api = new FakeEvidenceApi();
  const uploader = new EvidenceUploader(api, workRoot);

  await assert.rejects(
    () => uploader.upload("run-escaped", { [keyFor(pngBytes)]: escapedEvidence }),
    (error: unknown) => error instanceof EvidenceUploadError && error.code === "INVALID_PATH"
  );
  assert.equal(api.calls.length, 0);
});

test("rejects a configured run-directory symlink even when it targets inside the work root", {
  skip: process.platform === "win32"
}, async () => {
  const { workRoot, runDirectory, evidenceKey } = await fixture();
  const linkedRun = join(workRoot, "run-linked");
  await symlink(runDirectory, linkedRun);
  const api = new FakeEvidenceApi();
  const uploader = new EvidenceUploader(api, workRoot);

  await assert.rejects(
    () => uploader.upload("run-linked", { [evidenceKey]: join(linkedRun, "capture.png") }),
    (error: unknown) => error instanceof EvidenceUploadError && error.code === "INVALID_PATH"
  );
  assert.equal(api.calls.length, 0);
});

test("rejects a final-file symlink even when its target remains in the run directory", {
  skip: process.platform === "win32"
}, async () => {
  const { workRoot, runDirectory, evidencePath, evidenceKey } = await fixture();
  const linkedPath = join(runDirectory, "linked-inside.png");
  await symlink(evidencePath, linkedPath);
  const api = new FakeEvidenceApi();
  const uploader = new EvidenceUploader(api, workRoot);

  await assert.rejects(
    () => uploader.upload("run-1", { [evidenceKey]: linkedPath }),
    (error: unknown) => error instanceof EvidenceUploadError && error.code === "INVALID_PATH"
  );
  assert.equal(api.calls.length, 0);
});

test("rejects a regular-file replacement between validation and open", async () => {
  const { workRoot, runDirectory, evidencePath, evidenceKey } = await fixture();
  const replacementPath = join(runDirectory, "replacement.png");
  const originalPath = join(runDirectory, "original.png");
  await writeFile(replacementPath, pngBytes);
  let swapped = false;
  const api = new FakeEvidenceApi();
  const uploader = new EvidenceUploader(api, workRoot, {
    fileSystem: {
      realpath,
      lstat,
      async open(path, flags) {
        if (!swapped) {
          swapped = true;
          await rename(path, originalPath);
          await rename(replacementPath, evidencePath);
        }
        return open(path, flags);
      }
    }
  });

  await assert.rejects(
    () => uploader.upload("run-1", { [evidenceKey]: evidencePath }),
    (error: unknown) => error instanceof EvidenceUploadError && error.code === "INVALID_PATH"
  );
  assert.equal(api.calls.length, 0);
});

test("rejects a run-directory replacement that preserves the evidence file inode", {
  skip: process.platform === "win32"
}, async () => {
  const { workRoot, runDirectory, evidencePath, evidenceKey } = await fixture();
  const replacementRun = join(workRoot, "run-replacement");
  const displacedRun = join(workRoot, "run-displaced");
  await mkdir(replacementRun);
  await link(evidencePath, join(replacementRun, "capture.png"));
  let swapped = false;
  const api = new FakeEvidenceApi();
  const uploader = new EvidenceUploader(api, workRoot, {
    fileSystem: {
      realpath,
      lstat,
      async open(path, flags) {
        const handle = await open(path, flags);
        return new Proxy(handle, {
          get(target, property) {
            if (property === "readFile") {
              return async () => {
                const bytes = await target.readFile();
                swapped = true;
                await rename(runDirectory, displacedRun);
                await rename(replacementRun, runDirectory);
                return bytes;
              };
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          }
        });
      }
    }
  });

  await assert.rejects(
    () => uploader.upload("run-1", { [evidenceKey]: evidencePath }),
    (error: unknown) => error instanceof EvidenceUploadError && error.code === "INVALID_PATH"
  );
  assert.equal(swapped, true);
  assert.equal(api.calls.length, 0);
});

test("rejects a direct-child replacement after reading but before byte acceptance", {
  skip: process.platform === "win32"
}, async () => {
  const { workRoot, runDirectory, evidencePath, evidenceKey } = await fixture();
  const replacementPath = join(runDirectory, "replacement-after-read.png");
  const displacedPath = join(runDirectory, "capture-before-read.png");
  await writeFile(replacementPath, pngBytes);
  let swapped = false;
  const api = new FakeEvidenceApi();
  const uploader = new EvidenceUploader(api, workRoot, {
    fileSystem: {
      realpath,
      lstat,
      async open(path, flags) {
        const handle = await open(path, flags);
        return new Proxy(handle, {
          get(target, property) {
            if (property === "readFile") {
              return async () => {
                const bytes = await target.readFile();
                swapped = true;
                await rename(evidencePath, displacedPath);
                await rename(replacementPath, evidencePath);
                return bytes;
              };
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          }
        });
      }
    }
  });

  await assert.rejects(
    () => uploader.upload("run-1", { [evidenceKey]: evidencePath }),
    (error: unknown) => error instanceof EvidenceUploadError && error.code === "INVALID_PATH"
  );
  assert.equal(swapped, true);
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
