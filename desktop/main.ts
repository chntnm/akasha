/**
 * Akasha desktop: Electron shell around the local HTTP server.
 *
 * Why a desktop build?
 *   - Browser tabs run with whatever GPU context is available
 *   - Here we unlock hardware acceleration (GPU rasterization,
 *     zero-copy uploads, no GPU blocklist) so large scenes (20k+ links) render
 *     on dedicated GPU with headroom for bloom and particle effects
 *   - Result: smooth interaction even with complex vaults
 *
 * Architecture:
 *   - App starts server on localhost (isolated from network)
 *   - Electron BrowserWindow loads the server URL
 *   - Menu provides vault management (Open, Rescan) + settings
 *   - Settings (excludes list) persist in userData
 *   - Graph and layout caches stored in userData (packaged apps can't write to bundle)
 *
 * esbuild bundles this file to CommonJS (npm run desktop:build), so __dirname works.
 */

import { app, BrowserWindow, Menu, dialog, shell } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import type { AddressInfo } from "node:net";
import { createApp, type AkashaApp } from "../server/app";
import { scanVault, type VaultGraph } from "../scanner/scan";
import { ensureDataDir, graphPathFor, listVaults, recordVault } from "../server/vaults";

// ===== GPU ACCELERATION: set before app.ready() =====
// Unlock hardware acceleration and zero-copy uploads for large scene performance
app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("enable-zero-copy");

// ===== DATA PATHS =====
// Packaged apps live in a read-only bundle, so vault data goes to userData
const ROOT = resolve(__dirname, "..", ".."); // desktop/dist -> repo root (or app.asar root)
const WEB_DIST = resolve(ROOT, "web", "dist");

// Set once app is ready (userData path not reliable before that)
let GRAPH_PATH = "";

// ===== SETTINGS PERSISTENCE =====
// User excludes (folders to ignore) are persisted in app userData
interface Settings {
  excludes: string[];
}

const settingsPath = () => resolve(app.getPath("userData"), "akasha-settings.json");

function loadSettings(): Settings {
  try {
    return JSON.parse(readFileSync(settingsPath(), "utf-8"));
  } catch {
    return { excludes: [] };
  }
}

function saveSettings(s: Settings) {
  // Save settings to userData (persistent across restarts)
  mkdirSync(dirname(settingsPath()), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify(s, null, 2));
}

let server: AkashaApp | null = null;
let baseUrl = "";
let win: BrowserWindow | null = null;

// ===== VAULT SCANNING & MANAGEMENT =====
// Native folder picker; returns the chosen path, or null if cancelled.
async function pickVaultFolder(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title: "Open vault folder",
    properties: ["openDirectory"],
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

async function reportScan(g: VaultGraph) {
  const s = g.meta.scanStats;
  await dialog.showMessageBox({
    message: `Scanned ${g.meta.vaultName}`,
    detail:
      `${g.meta.notes} notes · ${g.meta.links} links · ${g.meta.phantoms} unwritten targets
` +
      `${s.ms}ms — ${s.parsed} parsed, ${s.reused} from cache`,
    buttons: ["OK"],
  });
}

/**
 * Adopt whatever vault the server now holds: retitle, rebuild the menu so
 * Recent Vaults reflects the change, and reload the page.
 *
 * The localStorage wipe is the part that matters. Filter rules and
 * collapsed-folder paths describe one vault; carried into another, a filter
 * written for the old vault can match almost nothing in the new one and the
 * graph comes back looking empty, as though the switch had failed. The
 * browser build clears these in its own switch path — this is the same
 * clearing for the route that reloads the window directly.
 */
function adoptVault() {
  if (!server) return;
  const m = server.meta();
  win?.setTitle(`Akasha — ${m.vaultName} (${m.notes} notes)`);
  buildMenu();
  win?.webContents
    .executeJavaScript(
      "localStorage.removeItem('akasha-filters');" +
        "localStorage.removeItem('akasha-tree-collapsed');"
    )
    .catch(() => {
      /* nothing loaded yet — the reload starts clean regardless */
    })
    .finally(() => win?.reload());
}

/**
 * Point the running app at a different vault. The scan is synchronous, so a
 * large vault holds the UI for a few seconds before the summary dialog.
 */
async function openVaultAt(vault: string) {
  if (!server) return;
  try {
    const g = server.switchVault(vault);
    await reportScan(g);
    adoptVault();
  } catch (e) {
    dialog.showErrorBox("Could not open vault", e instanceof Error ? e.message : String(e));
  }
}

/**
 * Re-scan the currently loaded vault (incremental).
 *
 * Routed through the server so it always writes to the active vault's data
 * directory. A second scanVault() call here would write to whichever path
 * this file captured at startup and silently diverge from the graph the
 * server re-reads, the moment a switch has happened.
 */
function rescanCurrentVault() {
  if (!server) return;
  const m = server.meta();

  if (!existsSync(m.vaultPath)) {
    dialog.showErrorBox("Vault missing", `Cannot find ${m.vaultPath}`);
    return;
  }

  server.rescan();
  adoptVault();
}

/**
 * Vaults opened before, newest first, minus the one already showing. Built
 * fresh on every buildMenu() call, which adoptVault() triggers after a
 * switch, so the list never goes stale. Capped at ten — past that it stops
 * being a shortcut.
 */
function recentVaultItems(): MenuItemConstructorOptions[] {
  const current = server?.meta().vaultPath;
  const rows = listVaults().filter((v) => v.path !== current);
  if (!rows.length) return [{ label: "No other vaults yet", enabled: false }];
  return rows.slice(0, 10).map((v) => ({
    label: `${v.name}  —  ${v.notes} notes`,
    toolTip: v.path,
    click: () => void openVaultAt(v.path),
  }));
}

function buildMenu() {
  const menu = Menu.buildFromTemplate([
    {
      label: "File",
      submenu: [
        {
          label: "Open Vault…",
          accelerator: "CmdOrCtrl+O",
          click: async () => {
            const vault = await pickVaultFolder();
            if (vault) await openVaultAt(vault);
          },
        },
        { label: "Recent Vaults", submenu: recentVaultItems() },
        {
          label: "Rescan Current Vault",
          accelerator: "CmdOrCtrl+Shift+R",
          click: rescanCurrentVault,
        },
        { type: "separator" },
        {
          label: "Open in Browser",
          click: () => shell.openExternal(baseUrl),
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "togglefullscreen" },
        { type: "separator" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { role: "resetZoom" },
        { type: "separator" },
        { role: "toggleDevTools" },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

async function start() {
  await app.whenReady();

  const legacyGraph = app.isPackaged
    ? resolve(app.getPath("userData"), "data", "graph.json")
    : resolve(ROOT, "data", "graph.json");

  if (existsSync(legacyGraph)) {
    // Keep booting from the graph this install already has, but register its
    // vault so it appears under Recent Vaults alongside anything opened with
    // the CLI. Nothing is moved; the first switch is what migrates this
    // install onto the per-vault directories.
    GRAPH_PATH = legacyGraph;
    try {
      const meta = JSON.parse(readFileSync(legacyGraph, "utf-8")).meta;
      if (meta?.vaultPath && existsSync(meta.vaultPath)) {
        recordVault(meta.vaultPath, meta.vaultName ?? basename(meta.vaultPath), meta.notes ?? 0);
      }
    } catch {
      // Unreadable graph: createApp below reports it properly.
    }
  } else {
    // First run: ask for a vault, and scan it straight into the per-vault
    // directory so new installs never touch the legacy location.
    const vault = await pickVaultFolder();
    if (!vault) {
      app.quit();
      return;
    }
    ensureDataDir(vault);
    GRAPH_PATH = graphPathFor(vault);
    const g = scanVault({ vault, out: GRAPH_PATH, exclude: loadSettings().excludes });
    recordVault(vault, g.meta.vaultName ?? basename(vault), g.meta.notes);
    await reportScan(g);
  }

  server = createApp(GRAPH_PATH, WEB_DIST);
  const listener = server.app.listen(0, "127.0.0.1", () => {
    const { port } = listener.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;

    const m = server!.meta();
    win = new BrowserWindow({
      width: 1680,
      height: 1000,
      backgroundColor: "#070a10",
      title: `Akasha — ${m.vaultName} (${m.notes} notes)`,
      autoHideMenuBar: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    // Keep the vault-aware title; the page's <title> would overwrite it.
    win.webContents.on("page-title-updated", (e) => e.preventDefault());
    win.loadURL(baseUrl);
    win.on("closed", () => {
      win = null;
    });
  });

  buildMenu();

  app.on("window-all-closed", () => app.quit());
}

start();
