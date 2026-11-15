#!/usr/bin/env node
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { Command } from "commander";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "./db/index.js";
import { listAdapters, matchAdapter } from "./core/router.js";
import { runJob } from "./core/runJob.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const program = new Command();

program
  .name("scrape")
  .description("Scrape listing pages into SQLite via Playwright adapters")
  .option("-u, --url <urls...>", "One or more seed URLs")
  .option("--headful", "Run browser with UI", false)
  .option("--delay-ms <n>", "Delay between pagination steps", (v) => parseInt(v, 10))
  .option("--max-pages <n>", "Max pages per job", (v) => parseInt(v, 10))
  .action(async () => {
    const opts = program.opts<{
      url?: string[];
      headful?: boolean;
      delayMs?: number;
      maxPages?: number;
    }>();

    if (!opts.url?.length) {
      program.help();
      return;
    }

    const databaseUrl = process.env.DATABASE_URL ?? "file:./data/scraper.db";
    if (databaseUrl.startsWith("file:")) {
      const dir = path.dirname(databaseUrl.replace(/^file:/, ""));
      await mkdir(dir, { recursive: true });
    }

    const db = await createDb(databaseUrl);
    const delayMs = opts.delayMs ?? parseInt(process.env.REQUEST_DELAY_MS ?? "800", 10);
    const maxPages = opts.maxPages ?? parseInt(process.env.MAX_PAGES ?? "500", 10);
    const storageStateDir = process.env.STORAGE_STATE_DIR;

    for (const url of opts.url) {
      const count = await runJob({
        db,
        seedUrl: url,
        delayMs,
        maxPages,
        storageStateDir,
        headless: !opts.headful,
      });
      console.log(`${url} -> ${count} new row(s) stored`);
    }
  });

program
  .command("list-adapters")
  .description("Print registered adapters")
  .action(() => {
    for (const a of listAdapters()) {
      console.log(`${a.id}\t${a.name}`);
    }
  });

program
  .command("match")
  .description("Show which adapter handles a URL")
  .argument("<url>", "URL to test")
  .action((url: string) => {
    const a = matchAdapter(url);
    console.log(a ? `${a.id} — ${a.name}` : "no adapter");
  });

program.addHelpText(
  "after",
  "\nPlaylist sync:\n  npx tsx src/index.ts sync-playlists [--options]\n  For flags see: python/sync_playlists.py --help\n  Uses .venv/bin/python when present, else VENV_PYTHON, else python3.\n",
);

function resolvePythonForSync(): string {
  if (process.env.VENV_PYTHON) return process.env.VENV_PYTHON;
  const unixVenv = path.join(repoRoot, ".venv", "bin", "python");
  if (existsSync(unixVenv)) return unixVenv;
  const winVenv = path.join(repoRoot, ".venv", "Scripts", "python.exe");
  if (existsSync(winVenv)) return winVenv;
  return "python3";
}

function forwardSyncPlaylistsIfPresent(): void {
  const argv = process.argv.slice(2);
  if (argv[0] !== "sync-playlists") return;
  const forwarded = argv.slice(1);
  const script = path.join(repoRoot, "python", "sync_playlists.py");
  const py = resolvePythonForSync();
  const result = spawnSync(py, [script, ...forwarded], {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  process.exit(result.status ?? 0);
}

forwardSyncPlaylistsIfPresent();

program.parseAsync().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
