import { randomBytes } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";

import { createLocalEnv } from "./local-env.mjs";

const envPath = resolve(".env");
const templatePath = resolve(".env.example");

try {
  await access(envPath, constants.F_OK);
  console.log("Local .env already exists; no changes made.");
} catch (error) {
  if (error.code !== "ENOENT") {
    throw error;
  }

  const template = await readFile(templatePath, "utf8");
  const masterKey = randomBytes(32).toString("hex");
  const localEnv = createLocalEnv(template, masterKey);

  try {
    await writeFile(envPath, localEnv, { flag: "wx" });
    console.log("Created local .env from .env.example.");
  } catch (writeError) {
    if (writeError.code !== "EEXIST") {
      throw writeError;
    }

    console.log("Local .env already exists; no changes made.");
  }
}
