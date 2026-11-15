import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.join(__dirname, "..", "..", "drizzle");

function normalizeLibsqlUrl(databaseUrl: string): string {
  if (databaseUrl.startsWith("file:")) {
    return databaseUrl;
  }
  return `file:${databaseUrl}`;
}

export async function createDb(databaseUrl: string) {
  const client = createClient({ url: normalizeLibsqlUrl(databaseUrl) });
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  return db;
}

export type Db = Awaited<ReturnType<typeof createDb>>;
