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

import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { exec } from "node:child_process";
import type { AddressInfo } from "node:net";
import { scanVault } from "../scanner/scan";
import { createApp } from "../server/app";
import { ensureDataDir, graphPathFor, recordVault } from "../server/vaults";

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
// Per-vault data directory, keyed by a hash of the vault path, so multiple
// vaults keep separate scan and layout caches. Shared with the server and the
// desktop app (see server/vaults.ts) so all three agree on where a given
// vault's data lives.
ensureDataDir(vault);
const graphPath = graphPathFor(vault);

// Scan vault (full or incremental based on --full flag)
console.log("Akasha — scanning " + vault);
const g = scanVault({ vault, out: graphPath, exclude: args.exclude, full: args.full });
const s = g.meta.scanStats;
console.log(
  `${g.meta.notes} notes, ${g.meta.links} links — ${s.ms}ms (${s.parsed} parsed, ${s.reused} cached)`
);
// Remember it, so this vault shows up in the in-app switcher's recents.
recordVault(vault, g.meta.vaultName ?? basename(vault), g.meta.notes);

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
