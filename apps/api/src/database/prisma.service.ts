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

export function createPrismaClient(databaseUrl = getDatabaseUrl()): PrismaClient {
  const adapter = new PrismaPg({ connectionString: databaseUrl });
  return new PrismaClient({ adapter });
}
