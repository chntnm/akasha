/**
 * Akasha scanner: walks an Obsidian vault and emits graph.json.
 *
 * CLI:    npm run scan -- "<path-to-vault>" [--out data/graph.json] [--exclude "Private/Drafts" ...] [--full]
 * API:    scanVault({ vault, out, exclude, full })   - used by the desktop
 *         app's "Open Vault…" and "Rescan" menu actions.
 *
 * Incremental by default: the scanner caches per-file parse results (word
 * count + raw wiki-link targets) in scan-cache.json keyed by mtime+size, so
 * a rescan only re-reads files that changed; the global link resolution is
 * recomputed in memory every time (it's the cheap part). Built for vaults
 * with tens of thousands of notes. --full forces a cold scan.
 *
 * Nodes are markdown files. Links come from two syntaxes: Obsidian [[wiki
 * links]] resolved by basename, and standard markdown links to .md files
 * ([text](path.md)) resolved by relative path. The second is what a Google
 * Open Knowledge Format bundle uses (a directory of .md concepts linked by
 * relative markdown links), so an OKF bundle renders as a graph too. Targets
 * that don't exist yet become "phantom" nodes, the way Obsidian renders
 * unresolved links.
 *
 * Full OKF support: each note's YAML frontmatter is parsed, so the node label
 * is the OKF `title` (falling back to the filename), `type` and `description`
 * are carried through to the graph, and the OKF `tags` list is read (preferred
 * over inline #hashtags). Nothing is read besides .md files and nothing leaves
 * the machine.
 */

import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, relative, sep, dirname } from "node:path";
import { createHash } from "node:crypto";

const DEFAULT_EXCLUDES = [
  ".obsidian",
  ".trash",
  ".agents",
  ".claude",
  ".git",
  "Raw",
  "graphify-out",
  "node_modules",
];

// Operational files at the vault root that aren't knowledge notes.
const ROOT_FILE_EXCLUDES = new Set([
  "claude.md",
  "log.md",
  ".log.md",
  "suggestions.md",
  "vault_index.md",
  "readme.md",
]);

// Regular expressions for parsing markdown vault syntax
// WIKI_LINK matches [[target]] or [[target#heading]] or [[target|display name]]
const WIKI_LINK = /\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g;

// TAG matches hashtags: #tagname starting with letter, up to 40 chars
const TAG = /(^|[\s>])#([A-Za-z][\w/-]{1,40})/g;

// MD_LINK matches a standard markdown link [text](target) but not an image
// ![text](target). The captured target is resolved as a relative .md path, so a
// Google Open Knowledge Format bundle (concepts linked by [name](path.md)) forms
// a graph the same way an Obsidian vault does with [[wiki links]].
const MD_LINK = /(?<!!)\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;

// Cache format version: increment when cache structure changes
// v2: per-file #tags added to the cache
// v3: markdown-link targets ([text](path.md)) added to the cached links array
// v4: OKF frontmatter (title, type, description, tags) parsed and cached
const CACHE_VERSION = 4;

export interface NodeRec {
  id: string; // vault-relative path, forward slashes
  title: string; // OKF frontmatter `title`, else the filename
  pillar: string; // top-level directory, or "Root"
  tags: string[]; // OKF `tags` frontmatter list, else inline #tags (up to 5)
  type?: string; // OKF `type` (the one required OKF field), if present
  description?: string; // OKF `description`, if present
  words: number;
  in: number;
  out: number;
  phantom?: boolean;
}

export interface LinkRec {
  source: string;
  target: string;
  weight: number;
}

export interface ScanOptions {
  vault: string;
  out?: string;
  exclude?: string[];
  /** Force a cold scan, ignoring the per-file cache. */
  full?: boolean;
}

export interface ScanStats {
  files: number;
  parsed: number;
  reused: number;
  removed: number;
  ms: number;
}

export interface VaultGraph {
  meta: {
    vaultPath: string;
    vaultName: string | undefined;
    scannedAt: string;
    /** Stable content fingerprint: unchanged vault => unchanged fingerprint.
     *  Keys the layout cache, so no-op rescans keep the settled layout. */
    fingerprint: string;
    excludes: string[];
    notes: number;
    phantoms: number;
    links: number;
    pillars: string[];
    scanStats: ScanStats;
  };
  nodes: NodeRec[];
  links: LinkRec[];
}

interface FileStat {
  rel: string;
  mtimeMs: number;
  size: number;
}

interface CachedFile {
  mtimeMs: number;
  size: number;
  words: number;
  tags: string[];
  links: string[]; // raw wiki-link targets, duplicates preserved for weights
  title?: string; // OKF frontmatter title
  type?: string; // OKF frontmatter type
  description?: string; // OKF frontmatter description
}

interface ScanCache {
  version: number;
  vaultPath: string;
  excludes: string[];
  files: Record<string, CachedFile>;
}

interface Frontmatter {
  title?: string;
  type?: string;
  description?: string;
  tags?: string[];
}

// Parse a leading OKF/YAML frontmatter block (a `---` fence at the very top).
// Dependency-free and forgiving: handles `key: value` scalars and `[a, b]` or
// comma lists for `tags`. Files without a fence return {} and are unaffected.
function parseFrontmatter(text: string): Frontmatter {
  if (!text.startsWith("---")) return {};
  const lines = text.split(/\r?\n/);
  if (lines[0].trim() !== "---") return {};
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return {};
  const fm: Frontmatter = {};
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    let val = line.slice(idx + 1).trim();
    if (key === "tags") {
      const inner = val.startsWith("[") && val.endsWith("]") ? val.slice(1, -1) : val;
      fm.tags = inner
        .split(",")
        .map((t) => t.trim().replace(/^['"]|['"]$/g, "").toLowerCase())
        .filter(Boolean);
    } else if (key === "title" || key === "type" || key === "description") {
      val = val.replace(/^['"]|['"]$/g, "");
      if (val) fm[key] = val;
    }
  }
  return fm;
}

// Collapse "." and ".." segments in a vault-relative POSIX path without
// touching the filesystem. Used to fold a markdown link's relative path
// (relative to the linking file's directory) into a vault-root-relative id.
function normalizeRelPath(p: string): string {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

// Resolve a markdown link target to a vault-relative path key (no .md suffix),
// or null if it isn't an in-vault note link. Skips external URLs, mailto/tel,
// pure anchors, and non-.md targets. `dir` is the linking file's directory.
function resolveMdLink(dir: string, target: string): string | null {
  let t = target.split("#")[0].trim();
  if (!t) return null;
  try {
    t = decodeURIComponent(t);
  } catch {
    // leave the raw target if it isn't valid percent-encoding
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^(mailto|tel):/i.test(t)) return null;
  if (!/\.md$/i.test(t)) return null;
  const joined = t.startsWith("/") ? t.slice(1) : dir ? dir + "/" + t : t;
  const norm = normalizeRelPath(joined).replace(/\.md$/i, "");
  return norm || null;
}

function walk(root: string, excludes: string[]): FileStat[] {
  const excludeSet = new Set(excludes.map((e) => e.replace(/\\/g, "/").toLowerCase()));
  const files: FileStat[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = resolve(dir, entry);
      const rel = relative(root, full).split(sep).join("/");
      if (excludeSet.has(rel.toLowerCase())) continue;
      const st = statSync(full);
      if (st.isDirectory()) {
        visit(full);
      } else if (entry.toLowerCase().endsWith(".md")) {
        if (!rel.includes("/") && ROOT_FILE_EXCLUDES.has(entry.toLowerCase())) continue;
        files.push({ rel, mtimeMs: st.mtimeMs, size: st.size });
      }
    }
  };
  visit(root);
  files.sort((a, b) => (a.rel < b.rel ? -1 : 1)); // deterministic fingerprint
  return files;
}

function loadCache(cachePath: string, vault: string, excludes: string[]): ScanCache | null {
  if (!existsSync(cachePath)) return null;
  try {
    const c: ScanCache = JSON.parse(readFileSync(cachePath, "utf-8"));
    if (
      c.version === CACHE_VERSION &&
      c.vaultPath === vault &&
      JSON.stringify(c.excludes) === JSON.stringify(excludes)
    )
      return c;
  } catch {
    // corrupt cache; fall through to a full scan
  }
  return null;
}

export function scanVault(opts: ScanOptions): VaultGraph {
  const t0 = Date.now();
  const vault = resolve(opts.vault);
  const extraExcludes = opts.exclude ?? [];
  const excludes = [...DEFAULT_EXCLUDES, ...extraExcludes];

  const files = walk(vault, excludes);

  // ---- Incremental parse: only read files whose modification time or size changed ----
  // This optimization allows rescans of large vaults (~5k+ notes) to complete in <100ms
  // for unchanged content. Parser results are keyed by file mtime+size.
  const outPath = opts.out ? resolve(opts.out) : null;
  const cachePath = outPath ? resolve(dirname(outPath), "scan-cache.json") : null;
  const cache = cachePath && !opts.full ? loadCache(cachePath, vault, extraExcludes) : null;

  const fileData = new Map<string, CachedFile>();
  let parsed = 0;
  let reused = 0;
  for (const f of files) {
    const prev = cache?.files[f.rel];
    if (prev && prev.mtimeMs === f.mtimeMs && prev.size === f.size) {
      fileData.set(f.rel, prev);
      reused++;
      continue;
    }
    const text = readFileSync(resolve(vault, f.rel), "utf-8");
    const links: string[] = [];
    for (const m of text.matchAll(WIKI_LINK)) {
      const raw = m[1].trim();
      if (raw) links.push(raw);
    }
    // Standard markdown links to .md files (the OKF link syntax). Resolved here
    // to a vault-relative path because the relative target depends on this
    // file's directory; the global resolver below then treats it path-first.
    const dir = f.rel.includes("/") ? f.rel.slice(0, f.rel.lastIndexOf("/")) : "";
    for (const m of text.matchAll(MD_LINK)) {
      const t = resolveMdLink(dir, m[1]);
      if (t) links.push(t);
    }
    // OKF tags (frontmatter list) take precedence; fall back to inline #tags.
    const fm = parseFrontmatter(text);
    const tags: string[] = [];
    const pushTag = (t: string) => {
      const lc = t.toLowerCase();
      if (lc && !tags.includes(lc) && tags.length < 5) tags.push(lc);
    };
    if (fm.tags && fm.tags.length) {
      for (const t of fm.tags) pushTag(t);
    } else {
      for (const m of text.matchAll(TAG)) pushTag(m[2]);
    }
    fileData.set(f.rel, {
      mtimeMs: f.mtimeMs,
      size: f.size,
      words: text.split(/\s+/).length,
      tags,
      links,
      title: fm.title,
      type: fm.type,
      description: fm.description,
    });
    parsed++;
  }
  const removed = cache
    ? Object.keys(cache.files).filter((k) => !fileData.has(k)).length
    : 0;

  // ---- Global link resolution: always recomputed in-memory ----
  // Obsidian resolves [[Name]] case-insensitively by basename (file name without extension)
  // and also by full path (e.g., [[folder/file]]). This ensures cross-vault portability.
  const byBasename = new Map<string, string>();
  const byPath = new Map<string, string>();
  for (const f of files) {
    const base = f.rel.split("/").pop()!.replace(/\.md$/i, "").toLowerCase();
    if (!byBasename.has(base)) byBasename.set(base, f.rel);
    byPath.set(f.rel.replace(/\.md$/i, "").toLowerCase(), f.rel);
  }

  const nodes = new Map<string, NodeRec>();
  for (const f of files) {
    const filename = f.rel.split("/").pop()!.replace(/\.md$/i, "");
    const pillar = f.rel.includes("/") ? f.rel.split("/")[0] : "Root";
    const fd = fileData.get(f.rel)!;
    nodes.set(f.rel, {
      id: f.rel,
      title: fd.title || filename, // OKF title, else filename
      pillar,
      tags: fd.tags ?? [],
      ...(fd.type ? { type: fd.type } : {}),
      ...(fd.description ? { description: fd.description } : {}),
      words: fd.words,
      in: 0,
      out: 0,
    });
  }

  // Track link weights (count of references between same pair of notes)
  // and create phantom nodes for unresolved wiki-link targets
  const edgeWeights = new Map<string, number>();
  let unresolved = 0;
  for (const [rel, fd] of fileData) {
    for (const raw of fd.links) {
      let target: string | undefined;
      
      // Resolve link target: path-based ("folder/file") or basename-based ("file")
      if (raw.includes("/")) {
        target =
          byPath.get(raw.toLowerCase()) ??
          byBasename.get(raw.split("/").pop()!.toLowerCase());
      } else {
        target = byBasename.get(raw.toLowerCase());
      }
      
      if (!target) {
        // Phantom node: linked target doesn't exist yet (user hasn't written it)
        // Obsidian displays these as unresolved links; we preserve them in the graph
        target = "phantom:" + raw.toLowerCase();
        if (!nodes.has(target)) {
          nodes.set(target, {
            id: target,
            title: raw,
            pillar: "Unwritten",
            tags: [],
            words: 0,
            in: 0,
            out: 0,
            phantom: true,
          });
          unresolved++;
        }
      }
      
      if (target === rel) continue; // Ignore self-links
      
      // Use '|' as separator (illegal in filenames, so no collisions possible)
      const key = rel + "|" + target;
      edgeWeights.set(key, (edgeWeights.get(key) ?? 0) + 1);
    }
  }

  const links: LinkRec[] = [];
  for (const [key, weight] of edgeWeights) {
    const [source, target] = key.split("|");
    links.push({ source, target, weight });
    nodes.get(source)!.out++;
    nodes.get(target)!.in++;
  }

  // Content fingerprint: stable for unchanged vaults, changes if any file added/removed/modified
  // This is sent to frontend and used as key for layout cache,
  // so unchanged rescans preserve node positions without re-running physics simulation
  const h = createHash("sha1");
  h.update(vault + "\0" + extraExcludes.join(",") + "\0");
  for (const f of files) h.update(f.rel + "|" + f.mtimeMs + "|" + f.size + "\n");
  const fingerprint = h.digest("hex").slice(0, 16);

  const pillars = [...new Set([...nodes.values()].map((n) => n.pillar))].sort();
  const stats: ScanStats = {
    files: files.length,
    parsed,
    reused,
    removed,
    ms: Date.now() - t0,
  };
  const graph: VaultGraph = {
    meta: {
      vaultPath: vault,
      vaultName: vault.split(sep).pop(),
      scannedAt: new Date().toISOString(),
      fingerprint,
      excludes: extraExcludes,
      notes: files.length,
      phantoms: unresolved,
      links: links.length,
      pillars,
      scanStats: stats,
    },
    nodes: [...nodes.values()],
    links,
  };

  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(graph));
    if (cachePath) {
      const cacheOut: ScanCache = {
        version: CACHE_VERSION,
        vaultPath: vault,
        excludes: extraExcludes,
        files: Object.fromEntries(fileData),
      };
      writeFileSync(cachePath, JSON.stringify(cacheOut));
    }
  }
  return graph;
}

// ---- CLI entry (skipped when imported, e.g. by the desktop app bundle) ----
if (process.argv[1] && /scan\.(ts|mts|js|mjs)$/i.test(process.argv[1])) {
  const argv = process.argv.slice(2);
  const args = { vault: "", out: "data/graph.json", exclude: [] as string[], full: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--exclude") args.exclude.push(argv[++i]);
    else if (argv[i] === "--full") args.full = true;
    else if (!args.vault) args.vault = argv[i];
  }
  if (!args.vault) {
    console.error(
      'usage: npm run scan -- "<vault-path>" [--out file] [--exclude rel/path]... [--full]'
    );
    process.exit(1);
  }
  console.log("Scanning " + resolve(args.vault));
  const g = scanVault({
    vault: args.vault,
    out: resolve(process.cwd(), args.out),
    exclude: args.exclude,
    full: args.full,
  });
  const s = g.meta.scanStats;
  console.log(
    `\n${g.meta.notes} notes, ${g.meta.links} links (${g.meta.phantoms} phantom targets)` +
      `\n${s.ms}ms — ${s.parsed} parsed, ${s.reused} from cache, ${s.removed} removed` +
      `\n-> ${resolve(process.cwd(), args.out)}`
  );
}
