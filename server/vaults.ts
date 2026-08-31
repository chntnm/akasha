/**
 * Per-vault data directories and the recent-vaults registry.
 *
 * Every vault Akasha has opened gets its own directory under ~/.akasha/,
 * keyed by a hash of its absolute path, holding that vault's graph.json,
 * scan-cache.json and layout.json. That layout predates this module (it was
 * inlined in bin/cli.ts); it lives here now so the CLI, the server and the
 * desktop app all agree on where a given vault's data belongs.
 *
 * The registry (~/.akasha/vaults.json) is what powers "recent vaults". It is
 * a convenience index, never the source of truth: if it is missing or stale
 * the vault directories on disk are authoritative, and listVaults() rebuilds
 * from them.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface VaultEntry {
  /** Absolute path to the vault folder. */
  path: string;
  /** Display name (the graph's vaultName, i.e. the folder's basename). */
  name: string;
  /** Note count from the last scan, for the recents list. */
  notes: number;
  /** ISO timestamp, used only for ordering the recents list. */
  lastOpened: string;
}

export const AKASHA_HOME = join(homedir(), ".akasha");
const REGISTRY = join(AKASHA_HOME, "vaults.json");

/**
 * Data directory for one vault.
 *
 * The hash must stay byte-identical to the one bin/cli.ts shipped with
 * (sha1 of the resolved path, first 10 hex chars) — changing it would orphan
 * every existing directory and force a cold rescan of vaults users already
 * have cached.
 */
export function dataDirFor(vaultPath: string): string {
  const vault = resolve(vaultPath);
  return join(AKASHA_HOME, createHash("sha1").update(vault).digest("hex").slice(0, 10));
}

/** Data directory for a vault, created if absent. */
export function ensureDataDir(vaultPath: string): string {
  const dir = dataDirFor(vaultPath);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** graph.json path for a vault (the file need not exist yet). */
export function graphPathFor(vaultPath: string): string {
  return join(dataDirFor(vaultPath), "graph.json");
}

/**
 * Excludes this vault was last scanned with, so re-opening it from the
 * recents list does not silently drop its exclude config. Empty for a vault
 * that has never been scanned.
 */
export function excludesFor(vaultPath: string): string[] {
  try {
    const meta = JSON.parse(readFileSync(graphPathFor(vaultPath), "utf-8")).meta;
    return Array.isArray(meta?.excludes) ? meta.excludes : [];
  } catch {
    return [];
  }
}

/**
 * Paths that name the same vault should collapse to one row. Windows paths
 * are case-insensitive, so C:\Vault and c:\vault are one vault to the user —
 * but they hash differently, so this normalisation is for the registry only
 * and never touches dataDirFor().
 */
const dedupeKey = (p: string) =>
  process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p);

function readRegistry(): VaultEntry[] {
  try {
    const raw = JSON.parse(readFileSync(REGISTRY, "utf-8"));
    return Array.isArray(raw?.vaults) ? raw.vaults : [];
  } catch {
    return [];
  }
}

/**
 * Recover registry entries by reading the graph.json in each vault data
 * directory. Without this the recents list is empty until the user switches
 * vaults once, even though their vaults are already cached on disk.
 */
function backfillFromDisk(): VaultEntry[] {
  const found: VaultEntry[] = [];
  let dirs: string[];
  try { dirs = readdirSync(AKASHA_HOME); } catch { return found; }
  for (const d of dirs) {
    const graph = join(AKASHA_HOME, d, "graph.json");
    if (!existsSync(graph)) continue;
    try {
      const meta = JSON.parse(readFileSync(graph, "utf-8")).meta;
      if (!meta?.vaultPath) continue;
      found.push({
        path: meta.vaultPath,
        name: meta.vaultName || "vault",
        notes: meta.notes ?? 0,
        // No record of when it was opened; the file's own mtime is the
        // closest honest stand-in and keeps the ordering sensible.
        lastOpened: statSync(graph).mtime.toISOString(),
      });
    } catch {
      // unreadable or half-written graph; skip it
    }
  }
  return found;
}

/**
 * Recent vaults, newest first.
 *
 * Vaults whose folder no longer exists are dropped rather than shown as dead
 * rows — scratch vaults under a temp directory are a normal thing to find in
 * the registry and offering to reopen one that is gone is just a broken
 * button.
 */
export function listVaults(): VaultEntry[] {
  const byKey = new Map<string, VaultEntry>();
  // Disk first, registry second: the registry wins on conflict because it
  // carries the real lastOpened.
  for (const e of [...backfillFromDisk(), ...readRegistry()]) {
    if (!e?.path || !existsSync(e.path)) continue;
    byKey.set(dedupeKey(e.path), e);
  }
  return [...byKey.values()].sort((a, b) => b.lastOpened.localeCompare(a.lastOpened));
}

/** Upsert one vault and stamp it as most recently opened. */
export function recordVault(vaultPath: string, name: string, notes: number): void {
  const entry: VaultEntry = {
    path: resolve(vaultPath),
    name,
    notes,
    lastOpened: new Date().toISOString(),
  };
  const keep = listVaults().filter((e) => dedupeKey(e.path) !== dedupeKey(entry.path));
  try {
    mkdirSync(AKASHA_HOME, { recursive: true });
    writeFileSync(REGISTRY, JSON.stringify({ vaults: [entry, ...keep] }, null, 2));
  } catch (e) {
    // A registry we cannot write costs the user their recents list, not their
    // vault — never fail a vault switch over it.
    console.error("Could not write vault registry:", e);
  }
}
