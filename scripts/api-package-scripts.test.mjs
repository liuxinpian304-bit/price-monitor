import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const apiPackage = JSON.parse(await readFile(new URL("../apps/api/package.json", import.meta.url), "utf8"));

test("API runtime commands load the repository root env file through Node", () => {
  for (const name of ["dev", "start", "seed:demo"]) {
    const command = apiPackage.scripts[name];
    assert.match(command, /^node /, `${name} must be launched by Node`);
    assert.match(command, /--env-file=\.\.\/\.\.\/\.env(?:\s|$)/, `${name} must load the root .env`);
    assert.match(command, /--import=tsx(?:\s|$)/, `${name} must register tsx`);
  }
  assert.match(apiPackage.scripts.dev, /--watch(?:\s|$)/);
});
