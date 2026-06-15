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
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { AddressInfo } from "node:net";
import { createApp, type AkashaApp } from "../server/app";
import { scanVault } from "../scanner/scan";

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
// Prompt user to select a vault directory and scan it
async function pickAndScanVault(): Promise<boolean> {
  // User selects vault directory via native file dialog
  const result = await dialog.showOpenDialog({
    title: "Open Obsidian vault",
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return false;
  
  const vault = result.filePaths[0];
  const settings = loadSettings();
  
  // Scan vault (incremental by default; only changed files are re-parsed)
  const g = scanVault({ vault, out: GRAPH_PATH, exclude: settings.excludes });
  server?.reload(); // Hot-swap graph if server already running
  
  // Show scan results to user
  const s = g.meta.scanStats;
  await dialog.showMessageBox({
    message: `Scanned ${g.meta.vaultName}`,
    detail:
      `${g.meta.notes} notes · ${g.meta.links} links · ${g.meta.phantoms} unwritten targets\n` +
      `${s.ms}ms — ${s.parsed} parsed, ${s.reused} from cache`,
    buttons: ["OK"],
  });
  return true;
}

// Re-scan the currently loaded vault (incremental)
// Checks vault path still exists, rescans changed files, reloads frontend
function rescanCurrentVault() {
  if (!server) return;
  const m = server.meta();
  
  if (!existsSync(m.vaultPath)) {
    dialog.showErrorBox("Vault missing", `Cannot find ${m.vaultPath}`);
    return;
  }
  
  // Scan only changed files
  const g = scanVault({ vault: m.vaultPath, out: GRAPH_PATH, exclude: m.excludes ?? [] });
  server.reload(); // Hot-swap graph
  win?.reload(); // Reload frontend
  win?.setTitle(`Akasha — ${g.meta.vaultName} (${g.meta.notes} notes)`);
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
            if (await pickAndScanVault()) {
              win?.reload();
              const m = server!.meta();
              win?.setTitle(`Akasha — ${m.vaultName} (${m.notes} notes)`);
            }
          },
        },
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

  GRAPH_PATH = app.isPackaged
    ? resolve(app.getPath("userData"), "data", "graph.json")
    : resolve(ROOT, "data", "graph.json");

  // First run without a scanned graph: ask for a vault before anything else.
  if (!existsSync(GRAPH_PATH)) {
    const ok = await pickAndScanVault();
    if (!ok) {
      app.quit();
      return;
    }
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
