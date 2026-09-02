import assert from "node:assert/strict";
import test from "node:test";

import {
  createPrismaClient,
  databaseSchemaFromUrl,
  getDatabaseUrl
} from "./prisma.service.ts";

test("requires DATABASE_URL before creating the database client", () => {
  assert.throws(() => getDatabaseUrl({}), /DATABASE_URL is required/);
});

test("passes an isolated schema query parameter through to the driver adapter", () => {
  assert.equal(
    databaseSchemaFromUrl("postgresql://user:secret@localhost:5432/database?schema=final_fix"),
    "final_fix"
  );
  assert.equal(databaseSchemaFromUrl("postgresql://user:secret@localhost:5432/database"), undefined);
  assert.throws(
    () => databaseSchemaFromUrl("postgresql://user:secret@localhost:5432/database?schema=bad%20schema"),
    /schema is invalid/
  );
});

test("creates a Prisma client for the configured PostgreSQL connection", async () => {
  const databaseUrl = getDatabaseUrl({
    DATABASE_URL: "postgresql://price_monitor:secret@localhost:5432/price_monitor"
  });
  const client = createPrismaClient(databaseUrl);

  assert.equal(typeof client.$connect, "function");
  assert.equal(typeof client.$disconnect, "function");
  await client.$disconnect();
});
