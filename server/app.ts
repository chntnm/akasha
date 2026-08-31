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
 *   GET  /api/vaults      - Current vault + recently opened vaults
 *   POST /api/vault       - Point the app at a different vault (scan + hot-swap)
 *   POST /api/claude      - Open a terminal running Claude Code in the vault
 *
 * Security:
 *   - All routes listen on 127.0.0.1 only (not exposed to network)
 *   - Note reads are confined to vault root (no directory traversal)
 *   - Vault data is never copied or uploaded; reads are live
 */

import express from "express";
import MiniSearch from "minisearch";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, realpathSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { DEFAULT_EXCLUDES, scanVault, type VaultGraph } from "../scanner/scan.js";
import { ensureDataDir, excludesFor, graphPathFor, listVaults, recordVault } from "./vaults.js";

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
  /** Rescan the current vault in place. */
  rescan(full?: boolean): VaultGraph;
  /** Point the app at a different vault, scanning it into its own data dir. */
  switchVault(vaultPath: string): VaultGraph;
  meta(): GraphFile["meta"];
}

/** Wrap a path for a POSIX shell: single-quote it, escaping embedded quotes. */
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Open a terminal running Claude Code with its working directory set to `cwd`.
 *
 * The vault path is passed as the child's `cwd`, never interpolated into a
 * command line, on the platform this is actually verified on (win32) — so a
 * vault called `Second Brain` needs no quoting and nothing in the path can be
 * read as an argument. The mac and Linux branches cannot do that (both hand a
 * string to a shell inside the terminal), so those quote explicitly.
 *
 * `claude` is resolved by the terminal's own PATH rather than looked up here
 * first: a lookup in this process's environment can disagree with the shell's,
 * and a false "not installed" for a working install is worse than the error
 * the opened window already shows. The window is kept open on exit precisely
 * so that message is readable.
 *
 * Only the win32 branch is tested; the others are best-effort.
 */
function launchClaude(cwd: string): void {
  const plat = process.platform;
  let child;
  if (plat === "win32") {
    // `start` is a cmd builtin, hence `cmd /c`. The empty string is start's
    // window-title argument: without it, start reads the first quoted token as
    // a title and opens a bare window instead of running anything.
    child = spawn("cmd", ["/c", "start", "", "powershell", "-NoLogo", "-NoExit", "-Command", "claude"], {
      cwd,
      detached: true,
      stdio: "ignore",
    });
  } else if (plat === "darwin") {
    const line = `cd ${shellQuote(cwd)} && claude`;
    const applescript = line.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    child = spawn(
      "osascript",
      ["-e", `tell application "Terminal" to do script "${applescript}"`, "-e", `tell application "Terminal" to activate`],
      { detached: true, stdio: "ignore" }
    );
  } else {
    // No standard way to open a terminal on Linux, so try the common ones in
    // order. gnome-terminal dropped `-e` in favour of `--`; the rest still
    // take `-e`. `exec $SHELL` keeps the window up after claude exits.
    const line = `cd ${shellQuote(cwd)} && claude; exec $SHELL`;
    const term = ["x-terminal-emulator", "gnome-terminal", "konsole", "xfce4-terminal", "alacritty", "kitty", "xterm"].find(
      (t) => spawnLookup(t)
    );
    if (!term) throw new Error("no terminal emulator found (tried x-terminal-emulator, gnome-terminal, konsole, xfce4-terminal, alacritty, kitty, xterm)");
    const args = term === "gnome-terminal" ? ["--", "sh", "-c", line] : ["-e", "sh", "-c", line];
    child = spawn(term, args, { detached: true, stdio: "ignore" });
  }
  // spawn reports a missing binary asynchronously, so this never rejects the
  // request — it just keeps the failure out of the server's stderr as a crash.
  child.on("error", (e) => console.error("Claude launch failed:", e.message));
  child.unref();
}

/** True if `bin` is on PATH. Used only to pick a Linux terminal, never for claude. */
function spawnLookup(bin: string): boolean {
  try {
    return spawnSync("which", [bin], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

export function createApp(initialGraphPath: string, staticDir?: string): AkashaApp {
  // Mutable: switchVault() repoints this at another vault's data directory.
  let graphPath = initialGraphPath;
  let graph: GraphFile;
  try {
    graph = JSON.parse(readFileSync(graphPath, "utf-8"));
  } catch (e) {
    throw new Error(`Failed to load graph at ${graphPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let vaultRoot: string = graph.meta.vaultPath;

  const app = express();

  // Mutating routes are POSTs with a JSON body, which is not a CORS-safelisted
  // request: another origin cannot send one without a preflight, and there is
  // no CORS middleware here to approve it. This is the belt to that
  // suspenders, and it matters more now that a POST can repoint the vault. A
  // missing Origin is allowed — Electron and curl both omit it, and neither is
  // a browser-driven cross-site request.
  app.use((req, res, next) => {
    if (req.method !== "POST") return next();
    const origin = req.get("origin");
    if (!origin) return next();
    let host = "";
    try { host = new URL(origin).hostname; } catch { /* unparseable: refuse */ }
    if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") {
      return next();
    }
    res.status(403).json({ error: "cross-origin request refused" });
  });

  // GET /api/graph: Return the complete knowledge graph (metadata + nodes + links)
  // Used by frontend to initialize the 3D visualization
  app.get("/api/graph", (_req, res) => {
    res.sendFile(graphPath, { dotfiles: "allow" });
  });

  // Layout cache lives beside graph.json — computed per call, not once, so it
  // follows the active vault across a switch.
  const layoutPath = () => resolve(dirname(graphPath), "layout.json");

  // GET /api/layout: Retrieve cached node positions from previous session
  // Allows hot-restart without re-running physics simulation (fast boot)
  // Keyed by graph fingerprint; if vault changed, cache is invalidated
  app.get("/api/layout", (_req, res) => {
    const path = layoutPath();
    if (!existsSync(path)) {
      res.status(404).json({ error: "no cached layout" });
      return;
    }
    res.sendFile(path, { dotfiles: "allow" });
  });
  
  // POST /api/layout: Persist settled node positions for fast subsequent boots
  // Frontend posts positions after physics simulation stabilizes
  app.post("/api/layout", express.json({ limit: "20mb" }), (req, res) => {
    try {
      writeFileSync(layoutPath(), JSON.stringify(req.body));
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

  // ---- vault assets: images / video / audio / pdf embedded in notes ----
  // Deliberately an allowlist rather than mime sniffing: .svg and .html are
  // omitted because, served same-origin, they can execute script. The
  // allowlist also honestly bounds what "embed" means.
  const MEDIA_TYPES: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif",
    ".bmp": "image/bmp",
    ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
    ".ogv": "video/ogg",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
    ".m4a": "audio/mp4", ".flac": "audio/flac",
    ".pdf": "application/pdf",
  };

  const excludeSet = () =>
    new Set(
      [...DEFAULT_EXCLUDES, ...(graph.meta.excludes ?? [])].map((e) =>
        e.replace(/\\/g, "/").toLowerCase()
      )
    );

  // lowercase basename -> vault-relative path. Obsidian's ![[image.png]] embeds
  // reference assets by bare filename, so resolution needs a name index.
  // Lazy like the search index; dropped in reload().
  let assetIndex: Map<string, string> | null = null;
  let assetIndexAt = 0;
  const ASSET_REINDEX_MS = 5000;

  /**
   * Basename -> relative path, rebuilding on a miss. Assets dropped into the
   * vault while the server is running aren't in the cached index, so a plain
   * cache would 404 every ![[new-image.png]] until the next rescan. The time
   * guard keeps a genuinely missing file from walking the vault on every
   * render.
   */
  function lookupAsset(name: string): string | undefined {
    if (!assetIndex) {
      assetIndex = buildAssetIndex();
      assetIndexAt = Date.now();
    }
    let hit = assetIndex.get(name);
    if (!hit && Date.now() - assetIndexAt > ASSET_REINDEX_MS) {
      assetIndex = buildAssetIndex();
      assetIndexAt = Date.now();
      hit = assetIndex.get(name);
    }
    return hit;
  }

  function buildAssetIndex(): Map<string, string> {
    const skip = excludeSet();
    const found = new Map<string, string>();
    const visit = (dir: string) => {
      let entries: string[];
      try { entries = readdirSync(dir); } catch { return; }
      for (const entry of entries) {
        const full = resolve(dir, entry);
        const rel = relative(vaultRoot, full).split(sep).join("/");
        if (skip.has(rel.toLowerCase()) || entry.startsWith(".")) continue;
        let st;
        try { st = statSync(full); } catch { continue; }
        if (st.isDirectory()) visit(full);
        else if (extname(entry).toLowerCase() in MEDIA_TYPES) {
          const key = entry.toLowerCase();
          if (!found.has(key)) found.set(key, rel); // first match wins, like Obsidian
        }
      }
    };
    visit(vaultRoot);
    return found;
  }

  // GET /api/file?path=...&from=...: serve one embedded asset.
  // `path` is the raw markdown target; `from` is the referencing note's id so
  // relative targets resolve against its folder. Falls back to a basename
  // lookup for Obsidian-style ![[image.png]].
  app.get("/api/file", (req, res) => {
    const raw = String(req.query.path ?? "").trim();
    if (!raw) {
      res.status(400).json({ error: "missing path" });
      return;
    }
    // Obsidian allows a display suffix (image.png|300) and anchors
    const target = raw.split("|")[0].split("#")[0].trim();
    const from = String(req.query.from ?? "");

    const candidates: string[] = [];
    if (from) candidates.push(join(dirname(from), target).split(sep).join("/"));
    candidates.push(target);
    const named = lookupAsset(basename(target).toLowerCase());
    if (named) candidates.push(named);

    let vaultReal: string;
    try { vaultReal = realpathSync(vaultRoot); } catch { vaultReal = resolve(vaultRoot); }

    for (const cand of candidates) {
      const full = resolve(vaultRoot, cand);
      if (!existsSync(full)) continue;
      // Resolve symlinks *before* the containment check: resolve() alone would
      // let a link inside the vault point at a file outside it.
      let real: string;
      try { real = realpathSync(full); } catch { continue; }
      if (real !== vaultReal && !real.startsWith(vaultReal + sep)) continue;
      const type = MEDIA_TYPES[extname(real).toLowerCase()];
      if (!type) continue;
      res.type(type);
      res.sendFile(real);
      return;
    }
    res.status(404).json({ error: "file not found" });
  });

  // ---- vault file tree (Obsidian-style explorer) ----
  // Lists every file, not just the markdown the graph indexes, so the explorer
  // shows the vault as it actually is. `kind` tells the client what it can
  // open: notes select their graph node, media previews, everything else is
  // inert. Cached with the same short TTL as the asset index so files added
  // while the server runs still appear without a rescan.
  interface TreeFile { name: string; path: string; kind: "note" | "media" | "other" }
  interface TreeDir { name: string; path: string; dirs: TreeDir[]; files: TreeFile[] }

  let tree: TreeDir | null = null;
  let treeAt = 0;
  const TREE_TTL_MS = 5000;

  function buildTree(): TreeDir {
    const skip = excludeSet();
    const visit = (dir: string, relDir: string): TreeDir => {
      const node: TreeDir = {
        name: relDir === "" ? graph.meta.vaultName || "vault" : basename(relDir),
        path: relDir,
        dirs: [],
        files: [],
      };
      let entries: string[];
      try { entries = readdirSync(dir); } catch { return node; }
      for (const entry of entries) {
        if (entry.startsWith(".")) continue; // dotfiles/dotdirs stay hidden
        const full = resolve(dir, entry);
        const rel = relDir ? `${relDir}/${entry}` : entry;
        if (skip.has(rel.toLowerCase())) continue;
        let st;
        try { st = statSync(full); } catch { continue; }
        if (st.isDirectory()) {
          node.dirs.push(visit(full, rel));
        } else {
          const ext = extname(entry).toLowerCase();
          node.files.push({
            name: entry,
            path: rel,
            kind: ext === ".md" ? "note" : ext in MEDIA_TYPES ? "media" : "other",
          });
        }
      }
      const byName = (a: { name: string }, b: { name: string }) =>
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
      node.dirs.sort(byName);
      node.files.sort(byName);
      return node;
    };
    return visit(vaultRoot, "");
  }

  // GET /api/tree: nested folder/file listing for the explorer panel.
  app.get("/api/tree", (_req, res) => {
    try {
      if (!tree || Date.now() - treeAt > TREE_TTL_MS) {
        tree = buildTree();
        treeAt = Date.now();
      }
      res.json(tree);
    } catch (e) {
      console.error("Tree build failed:", e);
      res.status(500).json({ error: "tree failed" });
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
    assetIndex = null;
    tree = null;
    contents.clear();
  };

  /**
   * Rescan the vault currently loaded, in place. Incremental unless `full`:
   * the scan cache keys parse results by mtime+size, so an unchanged vault
   * re-scans in milliseconds.
   */
  function rescan(full = false): VaultGraph {
    const g = scanVault({
      vault: graph.meta.vaultPath,
      out: graphPath,
      exclude: graph.meta.excludes ?? [],
      full,
    });
    reload();
    return g;
  }

  /**
   * Point the app at a different vault.
   *
   * Each vault owns a directory under ~/.akasha keyed by its path, so
   * switching away and back reuses that vault's scan cache and settled layout
   * instead of paying for a cold scan. Excludes come from the target's own
   * previous scan rather than the vault being left, which would otherwise
   * apply one vault's ignore list to another.
   *
   * The scan is synchronous and a large vault takes seconds; callers are
   * expected to show progress rather than race it.
   */
  function switchVault(vaultPath: string): VaultGraph {
    const vault = resolve(vaultPath);
    if (!existsSync(vault)) throw new Error(`No such folder: ${vault}`);
    if (!statSync(vault).isDirectory()) throw new Error(`Not a folder: ${vault}`);

    ensureDataDir(vault);
    const nextGraphPath = graphPathFor(vault);
    const g = scanVault({ vault, out: nextGraphPath, exclude: excludesFor(vault) });
    // Repoint before reload(), which reads graphPath.
    graphPath = nextGraphPath;
    reload();
    // vaultName is optional on the scan result; the folder name is the fallback.
    recordVault(vault, g.meta.vaultName ?? basename(vault), g.meta.notes);
    return g;
  }

  // POST /api/rescan: Trigger incremental rescan of the vault
  // Re-parses files that have changed (by mtime+size), hot-swaps the graph,
  // and sends stats back to frontend for UI update.
  // Query param ?full=true forces a cold scan (ignores cache)
  app.post("/api/rescan", (req, res) => {
    try {
      const g = rescan(req.query.full === "true");
      res.json({ ok: true, notes: g.meta.notes, links: g.meta.links, stats: g.meta.scanStats });
    } catch (e) {
      console.error("Rescan failed:", e);
      res.status(500).json({ error: "rescan failed", details: e instanceof Error ? e.message : String(e) });
    }
  });

  // GET /api/vaults: the vault in view plus the ones opened before it, so the
  // switcher can offer history instead of making the user retype a path.
  app.get("/api/vaults", (_req, res) => {
    try {
      res.json({
        current: { path: graph.meta.vaultPath, name: graph.meta.vaultName, notes: graph.meta.notes },
        recents: listVaults(),
      });
    } catch (e) {
      console.error("Vault list failed:", e);
      res.status(500).json({ error: "vault list failed" });
    }
  });

  // POST /api/vault {path}: repoint the app at another vault and scan it.
  // The path is arbitrary and client-supplied, which is only acceptable
  // because this server is bound to 127.0.0.1 and already reads the vault the
  // user pointed it at. It is not a file-read primitive: a bad path is
  // rejected up front, and what comes back is a scan summary, never contents.
  app.post("/api/vault", express.json(), (req, res) => {
    const path = typeof req.body?.path === "string" ? req.body.path.trim() : "";
    if (!path) {
      res.status(400).json({ error: "missing path" });
      return;
    }
    try {
      const g = switchVault(path);
      res.json({
        ok: true,
        vaultName: g.meta.vaultName,
        vaultPath: g.meta.vaultPath,
        notes: g.meta.notes,
        links: g.meta.links,
        stats: g.meta.scanStats,
      });
    } catch (e) {
      const details = e instanceof Error ? e.message : String(e);
      console.error("Vault switch failed:", details);
      res.status(400).json({ error: "vault switch failed", details });
    }
  });

  // POST /api/claude: open a terminal running Claude Code in the current vault.
  //
  // Deliberately takes no parameters. The directory and the command both come
  // from server state, so the request cannot steer either — the worst a
  // cross-origin POST that slipped past the Origin check could do is open a
  // terminal in the vault the user already has open. Accepting a path here
  // would turn it into "run a process in any directory", which the Origin
  // check alone is not a strong enough lock for.
  app.post("/api/claude", (_req, res) => {
    const vault = graph.meta.vaultPath;
    // Validated when the vault was opened, but it can be deleted or unmounted
    // since; spawn() with a missing cwd throws ENOENT.
    if (!existsSync(vault)) {
      res.status(400).json({ error: "vault folder is missing", details: vault });
      return;
    }
    try {
      launchClaude(vault);
      res.json({ ok: true, cwd: vault });
    } catch (e) {
      const details = e instanceof Error ? e.message : String(e);
      console.error("Claude launch failed:", details);
      res.status(500).json({ error: "could not open a terminal", details });
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

  return { app, reload, rescan, switchVault, meta: () => graph.meta };
}
