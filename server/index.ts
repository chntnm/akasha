/**
 * Akasha server CLI: serves the built frontend plus the local-only API.
 *
 * Usage:
 *   npm start    (after npm run scan and npm run build)
 *   npx akasha-graph "<vault-path>"  (all-in-one: scan + serve + open browser)
 *
 * The server binds to 127.0.0.1 only (localhost); vault data never leaves the machine.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";

// Resolve graph.json path from environment or defaults
const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const GRAPH_PATH = process.env.AKASHA_GRAPH ?? resolve(ROOT, "data", "graph.json");
const PORT = Number(process.env.AKASHA_PORT ?? 5175);

// Verify graph.json exists before starting server
if (!existsSync(GRAPH_PATH)) {
  console.error(`No graph at ${GRAPH_PATH} \u2014 run:  npm run scan -- "<vault-path>"`);
  process.exit(1);
}

// Create server and bind to localhost
const { app, meta } = createApp(GRAPH_PATH, resolve(ROOT, "web", "dist"));
app.listen(PORT, "127.0.0.1", () => {
  const m = meta();
  console.log(`Akasha: http://localhost:${PORT}  (vault: ${m.vaultName}, ${m.notes} notes)`);
});
