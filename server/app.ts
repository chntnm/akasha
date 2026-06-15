/**
 * Akasha HTTP app factory, shared by the CLI server (server/index.ts) and
 * the Electron desktop app (desktop/main.ts).
 *
 * Public API routes (all localhost-only):
 *   GET /api/graph        - Returns the scanned graph.json metadata + topology
 *   GET /api/layout       - Cached node positions from previous session (optional)
 *   POST /api/layout      - Persist settled node positions for fast boot
 *   GET /api/note?id=...  - Reads raw markdown of one note from vault
 *   GET /api/search?q=... - Full-text search with fuzzy matching
 *   POST /api/rescan      - Trigger incremental rescan (hot-swap graph + reload frontend)
 *
 * Security:
 *   - All routes listen on 127.0.0.1 only (not exposed to network)
 *   - Note reads are confined to vault root (no directory traversal)
 *   - Vault data is never copied or uploaded; reads are live
 */

import express from "express";
import MiniSearch from "minisearch";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { scanVault } from "../scanner/scan.js";

interface GraphFile {
  meta: {
    vaultName: string;
    vaultPath: string;
    notes: number;
    excludes: string[];
  };
  nodes: Array<{ id: string; phantom?: boolean; title: string }>;
}

export interface AkashaApp {
  app: express.Express;
  /** Re-read graph.json (after a rescan / vault switch). */
  reload(): void;
  meta(): GraphFile["meta"];
}

export function createApp(graphPath: string, staticDir?: string): AkashaApp {
  let graph: GraphFile;
  try {
    graph = JSON.parse(readFileSync(graphPath, "utf-8"));
  } catch (e) {
    throw new Error(`Failed to load graph at ${graphPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let vaultRoot: string = graph.meta.vaultPath;

  const app = express();

  // GET /api/graph: Return the complete knowledge graph (metadata + nodes + links)
  // Used by frontend to initialize the 3D visualization
  app.get("/api/graph", (_req, res) => {
    res.sendFile(graphPath, { dotfiles: "allow" });
  });

  // Layout cache lives beside graph.json
  const layoutPath = resolve(dirname(graphPath), "layout.json");

  // GET /api/layout: Retrieve cached node positions from previous session
  // Allows hot-restart without re-running physics simulation (fast boot)
  // Keyed by graph fingerprint; if vault changed, cache is invalidated
  app.get("/api/layout", (_req, res) => {
    if (!existsSync(layoutPath)) {
      res.status(404).json({ error: "no cached layout" });
      return;
    }
    res.sendFile(layoutPath, { dotfiles: "allow" });
  });
  
  // POST /api/layout: Persist settled node positions for fast subsequent boots
  // Frontend posts positions after physics simulation stabilizes
  app.post("/api/layout", express.json({ limit: "20mb" }), (req, res) => {
    try {
      writeFileSync(layoutPath, JSON.stringify(req.body));
      res.json({ ok: true });
    } catch (e) {
      console.error("Failed to save layout:", e);
      res.status(500).json({ error: "save failed" });
    }
  });

  // GET /api/note?id=...: Retrieve raw markdown of a single note
  // id should be a vault-relative path (e.g., "folder/file" or "file.md")
  // Security: Validates that the path stays within vault root (no traversal)
  app.get("/api/note", (req, res) => {
    const id = String(req.query.id ?? "");
    
    // Reject phantom nodes (unwritten link targets) and empty ids
    if (!id || id.startsWith("phantom:")) {
      res.status(404).json({ error: "note not found" });
      return;
    }
    
    // Construct full path and validate it stays within vault
    const full = resolve(vaultRoot, id);
    const vaultBase = resolve(vaultRoot) + sep;
    
    // Security check: prevent directory traversal attacks
    if (!full.startsWith(vaultBase) || !full.toLowerCase().endsWith(".md")) {
      res.status(400).json({ error: "invalid note id" });
      return;
    }
    
    // Check file exists
    if (!existsSync(full)) {
      res.status(404).json({ error: "note not found" });
      return;
    }
    
    // Return the note's raw markdown content
    try {
      res.json({ id, markdown: readFileSync(full, "utf-8") });
    } catch (e) {
      console.error(`Failed to read note ${id}:`, e);
      res.status(500).json({ error: "read failed" });
    }
  });

  // Full-text index over note content (titles boosted). Built lazily on the
  // first search (~1-2s for ~2k notes), held in memory, invalidated by
  // reload(). Contents stay in local memory for snippet extraction.
  let index: MiniSearch | null = null;
  let contents = new Map<string, string>();

  function buildIndex() {
    const ms = new MiniSearch({
      fields: ["title", "content"],
      storeFields: ["title"],
      searchOptions: { boost: { title: 3 }, prefix: true, fuzzy: 0.15 },
    });
    contents = new Map();
    const docs = [];
    for (const n of graph.nodes) {
      if (n.phantom) continue;
      try {
        const text = readFileSync(resolve(vaultRoot, n.id), "utf-8");
        contents.set(n.id, text);
        docs.push({ id: n.id, title: n.title, content: text });
      } catch {
        // file moved/deleted since scan; skip it
      }
    }
    ms.addAll(docs);
    return ms;
  }

  function snippet(id: string, terms: string[]): string {
    const text = contents.get(id) ?? "";
    const lower = text.toLowerCase();
    for (const t of terms) {
      const at = lower.indexOf(t.toLowerCase());
      if (at >= 0) {
        const start = Math.max(0, at - 50);
        const end = Math.min(text.length, at + t.length + 70);
        return (
          (start > 0 ? "…" : "") +
          text.slice(start, end).replace(/\s+/g, " ").trim() +
          (end < text.length ? "…" : "")
        );
      }
    }
    return "";
  }

  // GET /api/search?q=...: Full-text search over note titles and content
  // Returns top 20 matches sorted by relevance score with text snippets
  // Search is fuzzy (typo-tolerant) with title boost (3x weight)
  // Lazy-built on first search; invalidated by rescan
  app.get("/api/search", (req, res) => {
    const q = String(req.query.q ?? "").trim();
    if (!q) {
      res.json([]);
      return;
    }
    
    try {
      // Lazily build full-text index on first search
      index ??= buildIndex();
      const hits = index.search(q).slice(0, 20).map((h) => ({
        id: h.id as string,
        title: h.title as string,
        score: h.score,
        snippet: snippet(h.id as string, h.terms),
      }));
      res.json(hits);
    } catch (e) {
      console.error("Search error:", e);
      res.status(500).json({ error: "search failed" });
    }
  });

  const reload = () => {
    graph = JSON.parse(readFileSync(graphPath, "utf-8"));
    vaultRoot = graph.meta.vaultPath;
    index = null; // rebuilt lazily against the new scan
    contents.clear();
  };

  // POST /api/rescan: Trigger incremental rescan of the vault
  // Re-parses files that have changed (by mtime+size), hot-swaps the graph,
  // and sends stats back to frontend for UI update.
  // Query param ?full=true forces a cold scan (ignores cache)
  app.post("/api/rescan", (req, res) => {
    try {
      const g = scanVault({
        vault: graph.meta.vaultPath,
        out: graphPath,
        exclude: graph.meta.excludes ?? [],
        full: req.query.full === "true",
      });
      reload();
      res.json({ ok: true, notes: g.meta.notes, links: g.meta.links, stats: g.meta.scanStats });
    } catch (e) {
      console.error("Rescan failed:", e);
      res.status(500).json({ error: "rescan failed", details: e instanceof Error ? e.message : String(e) });
    }
  });

  // dev instrumentation: the frontend posts measured FPS here (?fpsreport=1)
  app.post("/api/fpslog", express.json(), (req, res) => {
    console.log("FPSLOG", JSON.stringify(req.body));
    res.json({ ok: true });
  });

  if (staticDir && existsSync(staticDir)) {
    app.use(express.static(staticDir));
  }

  return { app, reload, meta: () => graph.meta };
}
