#!/usr/bin/env node
/**
 * Akasha CLI, the zero-install on-ramp:
 *
 *   npx akasha-graph "<vault-path>" [--exclude rel/path]... [--port 5175] [--full] [--no-open]
 *
 * Scans the vault (incrementally), serves the 3D map on localhost, and opens
 * the browser. Per-vault data (graph, scan cache, layout cache) lives under
 * ~/.akasha/<vault-hash>/ so repeat runs boot from cache.
 *
 * Security: All vault data remains local; nothing is uploaded.
 * Performance: Incremental scanning caches parse results by mtime+size.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { exec } from "node:child_process";
import type { AddressInfo } from "node:net";
import { scanVault } from "../scanner/scan";
import { createApp } from "../server/app";

// Parse command-line arguments
const argv = process.argv.slice(2);
const args = { vault: "", exclude: [] as string[], port: 5175, full: false, open: true };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--exclude") args.exclude.push(argv[++i]);
  else if (a === "--port") args.port = Number(argv[++i]);
  else if (a === "--full") args.full = true;
  else if (a === "--no-open") args.open = false;
  else if (!args.vault) args.vault = a;
}

// Validate required vault argument
if (!args.vault) {
  console.error(
    'usage: akasha "<vault-path>" [--exclude rel/path]... [--port 5175] [--full] [--no-open]'
  );
  process.exit(1);
}

// Normalize vault path and verify it exists
const vault = resolve(args.vault);
if (!existsSync(vault)) {
  console.error("vault not found: " + vault);
  process.exit(1);
}
// Create per-vault data directory using hashed vault path as key
// This allows multiple vaults to maintain separate caches without conflicts
const dataDir = join(
  homedir(),
  ".akasha",
  createHash("sha1").update(vault).digest("hex").slice(0, 10)
);
mkdirSync(dataDir, { recursive: true });
const graphPath = join(dataDir, "graph.json");

// Scan vault (full or incremental based on --full flag)
console.log("Akasha — scanning " + vault);
const g = scanVault({ vault, out: graphPath, exclude: args.exclude, full: args.full });
const s = g.meta.scanStats;
console.log(
  `${g.meta.notes} notes, ${g.meta.links} links — ${s.ms}ms (${s.parsed} parsed, ${s.reused} cached)`
);

// Create Express server with graph API endpoints
const webDist = resolve(__dirname, "..", "web", "dist");
const { app } = createApp(graphPath, webDist);

// Start server on localhost (not exposed publicly)
const listener = app.listen(args.port, "127.0.0.1", () => {
  const { port } = listener.address() as AddressInfo;
  const url = `http://localhost:${port}`;
  console.log(`Akasha: ${url}   (Ctrl+C to stop)`);
  
  // Open browser if requested (default: true unless --no-open)
  if (args.open) {
    const cmd =
      process.platform === "win32"
        ? `start "" ${url}`
        : process.platform === "darwin"
          ? `open ${url}`
          : `xdg-open ${url}`;
    exec(cmd);
  }
});
