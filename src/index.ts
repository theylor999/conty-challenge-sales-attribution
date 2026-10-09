import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { serve } from "@hono/node-server";
import { systemClock } from "./clock.ts";
import { Db } from "./db.ts";
import { createApp } from "./http/app.ts";
import { SEED_CREATORS } from "./seed.ts";
import { SalesService } from "./service.ts";
import { seedCreators } from "./storage/directory.ts";

const dbPath = process.env.DB_PATH ?? "data/sales.db";
if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });

const db = new Db(dbPath);
seedCreators(db, SEED_CREATORS);

const app = createApp({
  service: new SalesService(db, systemClock),
  webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET || undefined,
});

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, () => {
  console.log(`listening on http://localhost:${port} (db: ${dbPath})`);
});
