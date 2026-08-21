import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class SecretStore {
  private readonly key: Buffer;

  constructor(masterKey: string) {
    if (masterKey.trim().length < 8) {
      throw new TypeError("SETTINGS_MASTER_KEY 至少需要 8 个字符");
    }
    this.key = createHash("sha256").update(masterKey).digest();
  }

  encrypt(plaintext: string): Buffer {
    if (plaintext.trim() === "") {
      throw new TypeError("密钥内容不能为空");
    }

    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([Buffer.from([VERSION]), iv, tag, ciphertext]);
  }

  decrypt(payload: Buffer): string {
    if (payload.length <= 1 + IV_BYTES + TAG_BYTES || payload[0] !== VERSION) {
      throw new TypeError("加密配置格式无效");
    }

    const ivStart = 1;
    const tagStart = ivStart + IV_BYTES;
    const ciphertextStart = tagStart + TAG_BYTES;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      payload.subarray(ivStart, tagStart)
    );
    decipher.setAuthTag(payload.subarray(tagStart, ciphertextStart));
    return Buffer.concat([
      decipher.update(payload.subarray(ciphertextStart)),
      decipher.final()
    ]).toString("utf8");
  }
}
