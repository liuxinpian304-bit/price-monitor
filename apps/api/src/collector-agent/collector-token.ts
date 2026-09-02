import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

function hashToken(plaintext: string): string {
  return `sha256:${createHash("sha256").update(plaintext, "utf8").digest("hex")}`;
}

export function createCollectorToken(): { plaintext: string; hash: string } {
  const plaintext = `pmc_${randomBytes(32).toString("base64url")}`;
  return { plaintext, hash: hashToken(plaintext) };
}

export function verifyCollectorToken(plaintext: string, hash: string): boolean {
  const candidate = Buffer.from(hashToken(plaintext), "utf8");
  const expected = Buffer.from(hash, "utf8");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
