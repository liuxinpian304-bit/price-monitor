import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../../../../generated/prisma/client.ts";

interface DatabaseEnvironment {
  DATABASE_URL?: string;
}

export function getDatabaseUrl(environment: DatabaseEnvironment = process.env): string {
  const databaseUrl = environment.DATABASE_URL?.trim();

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  return databaseUrl;
}

export function databaseSchemaFromUrl(databaseUrl: string): string | undefined {
  const schema = new URL(databaseUrl).searchParams.get("schema")?.trim();
  if (!schema) return undefined;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
    throw new Error("DATABASE_URL schema is invalid");
  }
  return schema;
}

export function createPrismaClient(databaseUrl = getDatabaseUrl()): PrismaClient {
  const schema = databaseSchemaFromUrl(databaseUrl);
  const adapter = schema
    ? new PrismaPg({
      connectionString: databaseUrl,
      options: `-c search_path=${schema}`
    }, { schema })
    : new PrismaPg({ connectionString: databaseUrl });
  return new PrismaClient({ adapter });
}
