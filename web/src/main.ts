/**
 * Akasha: interactive 3D map of an Obsidian vault.
 *
 * Interaction model (Obsidian-style):
 *   Left drag    - rotate the graph
 *   Scroll       - zoom in/out
 *   Right drag   - pan the view
 *   Arrow keys   - fly: ↑ forward, ↓ back, ←/→ strafe (Shift+arrows pan)
 *   Hover        - highlight connected neighbors
 *   Click        - select a node and focus on its neighborhood
 *   Double-click - open the note in Obsidian
 *   Search       - find and fly to a specific note
 *
 * Visual design:
 *   - Nodes: sized by degree (# of links); colored by pillar (folder) or first #tag
 *   - Links: base color at rest; highlighted along visible paths; weight shown by thickness
 *   - Labels: fade by distance from camera (Obsidian-style); always visible when selected
 *   - Bloom: optional glow effect (theme-dependent; cheaper at half resolution)
 *   - Starfield: immersive backdrop (theme-dependent; dense mode on Cosmos theme)
 *   - Particles: flow along highlighted links to show directionality
 *
 * Performance:
 *   - 20k+ links rendered as one merged buffer (single draw call, not per-link)
 *   - Physics simulation optional: if layout cached, graph appears instantly
 *   - Quality tiers: low (6px nodes, 1x res), medium (9px, 1.5x), high (18px, 2x)
 *   - Search index built lazily on first query; kept in memory; cleared on rescan
 */

import ForceGraph3D, { type ForceGraph3DInstance, type ConfigOptions } from "3d-force-graph";
import SpriteText from "three-spritetext";
import { marked } from "marked";
import * as THREE from "three";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";

// ===== DATA STRUCTURES =====
// GNode: A knowledge note (file) in the vault
interface GNode {
  id: string;
  title: string;
  pillar: string;
  tags?: string[];
  words: number;
  in: number;
  out: number;
  phantom?: boolean;
  x?: number;
  y?: number;
  z?: number;
}

interface GLink {
  source: string | GNode;
  target: string | GNode;
  weight: number;
}

interface Graph {
  meta: {
    vaultName: string;
    scannedAt: string;
    fingerprint: string;
    notes: number;
    links: number;
    phantoms: number;
    pillars: string[];
  };
  nodes: GNode[];
  links: GLink[];
}

// ===== THEME PALETTES & SETTINGS =====
// Each group (pillar/tag) gets a color; theme overrides are applied on top
const PALETTE: Record<string, string> = {
  Biology: "#51cf66",
  Chemistry: "#fcc419",
  Physics: "#339af0",
  Mathematics: "#845ef7",
  History: "#d9a36a",
  Metaphysics: "#b197fc",
  Books: "#ffa94d",
  Root: "#adb5bd",
  Unwritten: "#5c636a",
};
// Fallback colors when a pillar/tag isn't in PALETTE or theme overrides
const FALLBACK_COLORS = [
  "#e64980", "#15aabf", "#82c91e", "#fd7e14", "#4c6ef5", "#f06595", "#12b886", "#fab005",
  "#7950f2", "#fa5252", "#40c057", "#228be6", "#e8590c", "#0ca678", "#cc5de8", "#94d82d",
];

// ---- themes: each restyles scene, links, starfield, bloom, and UI together ----
// Theme definitions: each includes scene environment (colors, bloom, stars) + UI styles
// Themes are persisted in localStorage; ?theme= query param overrides
interface ThemeDef {
  label: string;
  bloom: boolean; // some themes (light) look wrong under bloom
  bg: string;
  linkBase: string; // merged buffer at rest
  linkOut: string; // outside focus
  linkLit: string; // selection/hover threads
  dim: string; // de-emphasized nodes
  selected: string;
  star: { color: number; opacity: number; mode: "off" | "normal" | "dense" };
  labels: { color: string; bg: string; border: string };
  palette?: Record<string, string>; // node-color overrides for contrast
  css: Record<string, string>; // UI panel variables
}

const THEMES: Record<string, ThemeDef> = {
  midnight: {
    label: "Midnight",
    bloom: true,
    bg: "#070a10",
    linkBase: "#6b7687",
    linkOut: "#161b26",
    linkLit: "#7fb4e8",
    dim: "rgba(70,75,85,0.18)",
    selected: "#ffffff",
    star: { color: 0x46506a, opacity: 0.55, mode: "normal" },
    labels: { color: "#e2e8f0", bg: "rgba(7,10,16,0.72)", border: "rgba(120,150,190,0.35)" },
    css: { "--bg": "#070a10", "--panel": "rgba(13,17,23,0.88)", "--border": "#30363d", "--fg": "#e6edf3", "--muted": "#8b949e", "--accent": "#58a6ff" },
  },
  gilded: {
    label: "Gilded",
    bloom: true,
    bg: "#040403",
    linkBase: "#8a6f2f",
    linkOut: "#171204",
    linkLit: "#f3cd6b",
    dim: "rgba(90,78,48,0.18)",
    selected: "#fff3d0",
    star: { color: 0x6b5a2a, opacity: 0.4, mode: "normal" },
    labels: { color: "#f0e6c8", bg: "rgba(10,8,2,0.78)", border: "rgba(212,175,55,0.45)" },
    css: { "--bg": "#040403", "--panel": "rgba(14,12,6,0.9)", "--border": "#3a3320", "--fg": "#ece4cc", "--muted": "#8a8064", "--accent": "#d4af37" },
  },
  manuscript: {
    label: "Manuscript",
    bloom: false,
    bg: "#f2ecdf",
    linkBase: "#5a5443",
    linkOut: "#e3dbc7",
    linkLit: "#1c1a14",
    dim: "rgba(187,178,154,0.5)",
    selected: "#16140e",
    star: { color: 0x000000, opacity: 0, mode: "off" },
    labels: { color: "#23201a", bg: "rgba(249,245,235,0.85)", border: "rgba(90,80,55,0.4)" },
    palette: {
      Biology: "#1e7d32", Chemistry: "#9a7d0a", Physics: "#1a5fb4",
      Mathematics: "#5e35b1", History: "#795548", Metaphysics: "#6a4c93", Books: "#b35c00",
      Root: "#5f6368", Unwritten: "#9e9e9e",
    },
    css: { "--bg": "#f2ecdf", "--panel": "rgba(250,246,237,0.92)", "--border": "#d6cdb6", "--fg": "#23201a", "--muted": "#6b6353", "--accent": "#8a6d1f" },
  },
  notebook: {
    label: "Notebook",
    bloom: false,
    bg: "#f4ecd8",
    linkBase: "#8a7a5c",
    linkOut: "#e6dcc2",
    linkLit: "#2b2417",
    dim: "rgba(170,155,120,0.5)",
    selected: "#1a1508",
    star: { color: 0x000000, opacity: 0, mode: "off" },
    labels: { color: "#2b2417", bg: "rgba(248,242,228,0.85)", border: "rgba(140,120,80,0.4)" },
    palette: {
      Biology: "#1e7d32", Chemistry: "#9a7d0a", Physics: "#1a5fb4",
      Mathematics: "#5e35b1", History: "#795548", Metaphysics: "#6a4c93", Books: "#b35c00",
      Root: "#5f6368", Unwritten: "#9e9e9e",
    },
    css: { "--bg": "#f4ecd8", "--panel": "rgba(247,240,224,0.94)", "--border": "#d8ccae", "--fg": "#2b2417", "--muted": "#6f6448", "--accent": "#a06a1f" },
  },
  cosmos: {
    label: "Cosmos",
    bloom: true,
    bg: "#020308",
    linkBase: "#56648a",
    linkOut: "#0a0d18",
    linkLit: "#9ecbff",
    dim: "rgba(60,70,95,0.16)",
    selected: "#ffffff",
    star: { color: 0x9aa8d8, opacity: 0.85, mode: "dense" },
    labels: { color: "#e2e8f0", bg: "rgba(4,6,14,0.7)", border: "rgba(140,165,215,0.4)" },
    css: { "--bg": "#020308", "--panel": "rgba(8,11,22,0.88)", "--border": "#252c42", "--fg": "#e6edf3", "--muted": "#828cab", "--accent": "#9ecbff" },
  },
  // ---- VS Code-inspired palettes (flat editor look, bloom off) ----
  dracula: {
    label: "Dracula",
    bloom: false,
    bg: "#282a36",
    linkBase: "#6272a4",
    linkOut: "#21222c",
    linkLit: "#bd93f9",
    dim: "rgba(98,114,164,0.18)",
    selected: "#f8f8f2",
    star: { color: 0x6272a4, opacity: 0.4, mode: "normal" },
    labels: { color: "#f8f8f2", bg: "rgba(40,42,54,0.78)", border: "rgba(189,147,249,0.4)" },
    css: { "--bg": "#282a36", "--panel": "rgba(40,42,54,0.9)", "--border": "#44475a", "--fg": "#f8f8f2", "--muted": "#6272a4", "--accent": "#bd93f9" },
  },
  nord: {
    label: "Nord",
    bloom: false,
    bg: "#2e3440",
    linkBase: "#4c566a",
    linkOut: "#2b303b",
    linkLit: "#88c0d0",
    dim: "rgba(76,86,106,0.2)",
    selected: "#eceff4",
    star: { color: 0x4c566a, opacity: 0.45, mode: "normal" },
    labels: { color: "#e5e9f0", bg: "rgba(46,52,64,0.78)", border: "rgba(136,192,208,0.4)" },
    css: { "--bg": "#2e3440", "--panel": "rgba(59,66,82,0.9)", "--border": "#434c5e", "--fg": "#eceff4", "--muted": "#81a1c1", "--accent": "#88c0d0" },
  },
  tokyonight: {
    label: "Tokyo Night",
    bloom: false,
    bg: "#1a1b26",
    linkBase: "#565f89",
    linkOut: "#16161e",
    linkLit: "#7aa2f7",
    dim: "rgba(86,95,137,0.2)",
    selected: "#c0caf5",
    star: { color: 0x565f89, opacity: 0.6, mode: "dense" },
    labels: { color: "#c0caf5", bg: "rgba(26,27,38,0.78)", border: "rgba(122,162,247,0.4)" },
    css: { "--bg": "#1a1b26", "--panel": "rgba(22,22,30,0.9)", "--border": "#2a2e42", "--fg": "#c0caf5", "--muted": "#565f89", "--accent": "#7aa2f7" },
  },
  gruvbox: {
    label: "Gruvbox",
    bloom: false,
    bg: "#282828",
    linkBase: "#665c54",
    linkOut: "#1d2021",
    linkLit: "#fabd2f",
    dim: "rgba(146,131,116,0.2)",
    selected: "#fbf1c7",
    star: { color: 0x665c54, opacity: 0.4, mode: "normal" },
    labels: { color: "#ebdbb2", bg: "rgba(40,40,40,0.8)", border: "rgba(250,189,47,0.4)" },
    css: { "--bg": "#282828", "--panel": "rgba(40,40,40,0.92)", "--border": "#3c3836", "--fg": "#ebdbb2", "--muted": "#928374", "--accent": "#fabd2f" },
  },
  monokai: {
    label: "Monokai",
    bloom: false,
    bg: "#272822",
    linkBase: "#75715e",
    linkOut: "#1d1e19",
    linkLit: "#66d9ef",
    dim: "rgba(117,113,94,0.2)",
    selected: "#f8f8f2",
    star: { color: 0x75715e, opacity: 0.4, mode: "normal" },
    labels: { color: "#f8f8f2", bg: "rgba(39,40,34,0.8)", border: "rgba(249,38,114,0.4)" },
    css: { "--bg": "#272822", "--panel": "rgba(39,40,34,0.92)", "--border": "#3e3d32", "--fg": "#f8f8f2", "--muted": "#75715e", "--accent": "#f92672" },
  },
};

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

// ===== BOOT & INITIALIZATION =====
async function boot() {
  // Fetch graph data (scanned vault topology) and cached layout (node positions from previous session)
  // Layout cache is keyed by content fingerprint; if vault unchanged, positions are reused
  const [data, layout] = await Promise.all([
    fetch("/api/graph").then((r) => r.json()) as Promise<Graph>,
    fetch("/api/layout")
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null) as Promise<{ fingerprint: string; positions: Record<string, number[]> } | null>,
  ]);

  // Layout cache hit: seed every node with its settled position and skip
  // the physics warm-up; the map appears settled on the first frame.
  // Keyed by content fingerprint, so no-op rescans don't invalidate it.
  // If fingerprint matches, graph appears instantly, already stable
  const cachedPositions =
    layout && layout.fingerprint === data.meta.fingerprint ? layout.positions : null;
  if (cachedPositions) {
    for (const n of data.nodes) {
      const p = cachedPositions[n.id];
      if (p) {
        n.x = p[0];
        n.y = p[1];
        n.z = p[2];
      }
    }
  }

  // --- theme state (drives scene + UI colors; persisted, ?theme= overrides) ---
  // ===== THEME STATE =====
  // Theme drives scene (background, link colors, stars) + UI panel styles
  // Persisted in localStorage; ?theme= query parameter overrides
  let theme =
    new URLSearchParams(window.location.search).get("theme") ||
    localStorage.getItem("akasha-theme") ||
    "midnight";
  if (!THEMES[theme]) theme = "midnight";
  const T = () => THEMES[theme];

  // --- grouping: color by top-level folder or by first #tag ---
  // No app is required to produce the input: any folder of markdown with
  // [[wiki links]] works. Folders give structure-groups; #tags give
  // meaning-groups; the user picks colors per group (persisted locally).
  // ===== GROUPING: COLOR BY PILLAR (FOLDER) OR BY FIRST #TAG =====
  // Allows both structural (folder-based) and semantic (tag-based) coloring
  // User picks a grouping mode (persisted); group colors are customizable and persisted
  let groupMode = (new URLSearchParams(window.location.search).get("group") ||
    localStorage.getItem("akasha-group") ||
    "folder") as "folder" | "tag";
  if (groupMode !== "tag") groupMode = "folder";
  let groups: string[] = [];
  let groupCounts = new Map<string, number>();
  const groupOfId = new Map<string, string>();
  const groupOf = (n: GNode) => groupOfId.get(n.id) ?? "other";

  function computeGroups() {
    groupOfId.clear();
    const raw = (n: GNode) =>
      n.phantom ? "Unwritten" : groupMode === "folder" ? n.pillar : (n.tags?.[0] ?? "untagged");
    const rawCounts = new Map<string, number>();
    for (const n of data.nodes) {
      const g = raw(n);
      rawCounts.set(g, (rawCounts.get(g) ?? 0) + 1);
    }
    // cap the legend: keep the 18 largest groups, bucket the rest as "other"
    const keep = new Set(
      [...rawCounts.entries()]
        .filter(([g]) => g !== "Unwritten")
        .sort((a, b) => b[1] - a[1])
        .slice(0, 18)
        .map(([g]) => g)
    );
    groupCounts = new Map();
    for (const n of data.nodes) {
      const g0 = raw(n);
      const g = g0 === "Unwritten" || keep.has(g0) ? g0 : "other";
      groupOfId.set(n.id, g);
      groupCounts.set(g, (groupCounts.get(g) ?? 0) + 1);
    }
    groups = [...groupCounts.keys()].sort(
      (a, b) => groupCounts.get(b)! - groupCounts.get(a)!
    );
  }

  // user-picked colors override theme + defaults; persisted per browser
  const customColors: Record<string, string> = JSON.parse(
    localStorage.getItem("akasha-colors") ?? "{}"
  );
  const colorOf: Record<string, string> = {};
  function recomputeColors() {
    let fb = 0;
    for (const g of groups) {
      colorOf[g] =
        customColors[g] ??
        T().palette?.[g] ??
        PALETTE[g] ??
        FALLBACK_COLORS[fb++ % FALLBACK_COLORS.length];
    }
    colorOf.Unwritten = customColors.Unwritten ?? T().palette?.Unwritten ?? PALETTE.Unwritten;
  }
  computeGroups();
  recomputeColors();

  // --- adjacency for hover/focus neighborhoods ---
  const neighbors = new Map<string, Set<string>>();
  const addNb = (a: string, b: string) => {
    if (!neighbors.has(a)) neighbors.set(a, new Set());
    neighbors.get(a)!.add(b);
  };
  for (const l of data.links) {
    addNb(l.source as string, l.target as string);
    addNb(l.target as string, l.source as string);
  }
  const byBasename = new Map<string, GNode>();
  const byId = new Map<string, GNode>();
  for (const n of data.nodes) {
    byId.set(n.id, n);
    byBasename.set(n.title.toLowerCase(), n);
  }
  const degree = (n: GNode) => n.in + n.out;

  // --- view state ---
  const pillarOn: Record<string, boolean> = {};
  for (const p of data.meta.pillars) pillarOn[p] = true;
  let showPhantoms = false;
  let showOrphans = true;
  let minWeight = 1; // hide links mentioned fewer than N times
  let hoverNode: GNode | null = null;
  let selected: GNode | null = null;
  let focusSet: Set<string> | null = null; // depth-limited neighborhood of selected
  let focusDepth = 2;

  // --- node filters: an ordered list of show/ignore rules (topmost wins) ---
  type Filter = { mode: "show" | "ignore"; pattern: string };
  let filters: Filter[] = loadFilters();
  let liveFilter: Filter | null = null; // unpersisted preview from the input row
  let filterHidden = new Set<string>(); // node ids hidden by the active chain

  const visible = (n: GNode) =>
    pillarOn[groupOf(n)] !== false &&
    (showPhantoms || !n.phantom) &&
    (showOrphans || degree(n) > 0) &&
    !filterHidden.has(n.id);

  const inFocus = (id: string) => !focusSet || focusSet.has(id);

  const endNode = (e: string | GNode): GNode => (typeof e === "object" ? e : byId.get(e)!);
  const linkShown = (l: GLink) =>
    l.weight >= minWeight && visible(endNode(l.source)) && visible(endNode(l.target));

  const bfs = (start: string, depth: number) => {
    const seen = new Set([start]);
    let frontier = [start];
    for (let d = 0; d < depth; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const nb of neighbors.get(id) ?? []) {
          if (!seen.has(nb)) {
            seen.add(nb);
            next.push(nb);
          }
        }
      }
      frontier = next;
    }
    return seen;
  };

  // --- graph ---
  // ---- graphics quality tiers (persisted; antialias applies on reload) ----
  // ===== GRAPHICS QUALITY TIERS =====
  // Allow users to trade visual fidelity for frame rate
  // Persisted in localStorage; applied on boot and when changed
  type QKey = "low" | "medium" | "high";
  const QUALITY: Record<QKey, { nodeRes: number; pixelRatio: number; bloom: boolean; stars: boolean; labels: number; pc: number }> = {
    low: { nodeRes: 6, pixelRatio: 1, bloom: false, stars: false, labels: 60, pc: 1024 },
    medium: { nodeRes: 9, pixelRatio: Math.min(window.devicePixelRatio || 1, 1.5), bloom: true, stars: true, labels: 140, pc: 4096 },
    high: { nodeRes: 18, pixelRatio: Math.min(window.devicePixelRatio || 1, 2), bloom: true, stars: true, labels: 260, pc: 16384 },
  };
  let quality: QKey = (localStorage.getItem("akasha-quality") as QKey) || "medium";
  if (!QUALITY[quality]) quality = "medium";

  // ---- rendering: 3D scene setup ----
  // The library's generics sit on its interface, not the constructor signature.
  const Graph3D = ForceGraph3D as unknown as new (
    el: HTMLElement,
    config?: ConfigOptions
  ) => ForceGraph3DInstance<GNode, GLink>;
  const graph = new Graph3D($("#graph"), {
    rendererConfig: {
      antialias: quality !== "low",
      powerPreference: "high-performance",
      preserveDrawingBuffer: true, // enables File > Export Image
    },
  })
    .graphData(data)
    .backgroundColor(T().bg)
    .showNavInfo(false)
    .nodeLabel(
      (n: GNode) =>
        `<div class="tip"><b>${n.title}</b><br>${n.pillar}${
          n.tags?.length ? " · #" + n.tags.slice(0, 3).join(" #") : ""
        } · ${degree(n)} links</div>`
    )
    .nodeVal((n: GNode) => Math.max(1.2, Math.sqrt(degree(n)) * 1.6))
    .nodeColor((n: GNode) => nodeColor(n))
    .nodeOpacity(1)
    .nodeResolution(QUALITY[quality].nodeRes)
    // The library only renders *lit* links (selection/hover): full-featured,
    // with width and particles. The other ~20k live in one merged buffer below.
    .linkColor(() => T().linkLit)
    .linkWidth(0.45)
    .linkOpacity(0.55)
    .nodeVisibility(visible)
    .linkVisibility((l: GLink) => isLit(l) && linkShown(l))
    .warmupTicks(cachedPositions ? 0 : 120)
    .cooldownTicks(cachedPositions ? 0 : 220)
    .onNodeHover((n: GNode | null) => {
      hoverNode = n;
      document.body.style.cursor = n ? "pointer" : "default";
      repaint();
    })
    .onNodeClick((n: GNode) => select(n))
    .onBackgroundClick(() => clearSelection());

  graph.d3Force("charge")!.strength(-45);

  // ---- rendering extras: bloom glow, starfield, particle flow ----
  // Half-resolution bloom: the blur is low-frequency anyway, half res is
  // visually identical and four times cheaper.
  // ===== RENDERING EXTRAS: BLOOM, STARFIELD, PARTICLES =====
  // Bloom glow: runs at half resolution (4x cheaper) for subtle halo effect
  // Starfield: two shells (faint background + optional dense immersive field)
  // Particles: flow along highlighted links to show reference direction
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth / 2, window.innerHeight / 2),
    0.35, // strength: subtle halo; higher washes out the dense core
    0.35, // radius
    0.3 // threshold
  );
  graph.postProcessingComposer().addPass(bloom);
  let glowOn = true;
  bloom.enabled = QUALITY[quality].bloom;

  // Starfield shells far behind the graph: a faint base field for the dark
  // themes, plus a dense immersive field that only Cosmos switches on.
  function makeStars(count: number, rMin: number, rSpread: number, size: number): THREE.Points {
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const r = rMin + Math.random() * rSpread;
      const thetaA = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3] = r * Math.sin(phi) * Math.cos(thetaA);
      positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(thetaA);
      positions[i * 3 + 2] = r * Math.cos(phi);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const pts = new THREE.Points(
      geo,
      new THREE.PointsMaterial({ color: 0xffffff, size, transparent: true, opacity: 0.5 })
    );
    graph.scene().add(pts);
    return pts;
  }
  const stars = makeStars(2400, 2200, 1400, 2.2);
  const denseStars = makeStars(7000, 1400, 3200, 1.5);

  function syncBloom() {
    bloom.enabled = glowOn && QUALITY[quality].bloom && T().bloom;
  }

  function syncEnvironment() {
    const q = QUALITY[quality];
    const st = T().star;
    for (const field of [stars, denseStars]) {
      (field.material as THREE.PointsMaterial).color.set(st.color);
      (field.material as THREE.PointsMaterial).opacity = st.opacity;
    }
    stars.visible = q.stars && st.mode !== "off";
    denseStars.visible = q.stars && st.mode === "dense";
    syncBloom();
  }
  syncEnvironment();

  function applyQuality(k: QKey) {
    quality = k;
    localStorage.setItem("akasha-quality", k);
    const q = QUALITY[k];
    graph.renderer().setPixelRatio(q.pixelRatio);
    maxLabels = q.labels;
    // particle count follows the tier unless the user pinned a value
    if (!localStorage.getItem("akasha-pc")) particleCount = q.pc;
    rebuildNodes(); // geometry resolution follows the tier
    syncEnvironment();
  }

  function applyTheme(k: string) {
    theme = THEMES[k] ? k : "midnight";
    localStorage.setItem("akasha-theme", theme);
    const t = T();
    for (const [prop, val] of Object.entries(t.css)) {
      document.documentElement.style.setProperty(prop, val);
    }
    graph.backgroundColor(t.bg);
    C_BASE.set(t.linkBase);
    C_LIT.set(t.linkLit);
    C_OUT.set(t.linkOut);
    recomputeColors();
    // restyle existing label chips: each setter regenerates the sprite's
    // texture, so skip when unchanged (boot would otherwise pay 1800×3 regens)
    for (const s of sprites.values()) {
      if (s.color !== t.labels.color) s.color = t.labels.color;
      if (s.backgroundColor !== t.labels.bg) s.backgroundColor = t.labels.bg;
      if (s.borderColor !== t.labels.border) s.borderColor = t.labels.border;
    }
    buildLegend();
    syncEnvironment();
    updateLinkColors();
    repaint();
  }

  // Directional particles flow along lit links (the only ones the library
  // renders) and show which way the references point.
  graph
    .linkDirectionalParticles(2)
    .linkDirectionalParticleWidth(1.4)
    .linkDirectionalParticleSpeed(0.008)
    .linkDirectionalParticleColor(() => "#9ecbff");

  graph.renderer().setPixelRatio(QUALITY[quality].pixelRatio);

  const isLit = (l: GLink) => {
    const s = (l.source as GNode).id ?? (l.source as unknown as string);
    const t = (l.target as GNode).id ?? (l.target as unknown as string);
    if (selected) return s === selected.id || t === selected.id;
    if (hoverNode) return s === hoverNode.id || t === hoverNode.id;
    return false;
  };

  function nodeColor(n: GNode): string {
    const base = colorOf[groupOf(n)];
    if (selected) {
      if (n.id === selected.id) return T().selected;
      return inFocus(n.id) ? base : T().dim;
    }
    if (hoverNode) {
      if (n.id === hoverNode.id) return T().selected;
      return neighbors.get(hoverNode.id)?.has(n.id) ? base : T().dim;
    }
    return base;
  }

  // ---- merged link rendering: 20k links -> one draw call ----
  // Each link used to be its own three.js object (one draw call apiece), the
  // dominant cost at this scale. All non-highlighted links now share a single
  // LineSegments buffer; hidden links collapse to degenerate (invisible) segments.
  const L = data.links.length;
  const linePos = new Float32Array(L * 6);
  const lineCol = new Float32Array(L * 6);
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute("position", new THREE.BufferAttribute(linePos, 3));
  lineGeo.setAttribute("color", new THREE.BufferAttribute(lineCol, 3));
  const lineMat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
  });
  const mergedLinks = new THREE.LineSegments(lineGeo, lineMat);
  mergedLinks.frustumCulled = false;
  graph.scene().add(mergedLinks);

  function updateLinkPositions() {
    for (let i = 0; i < L; i++) {
      const l = data.links[i];
      const o = i * 6;
      if (!linkShown(l)) {
        linePos.fill(0, o, o + 6);
        continue;
      }
      const s = endNode(l.source);
      const t = endNode(l.target);
      linePos[o] = s.x ?? 0;
      linePos[o + 1] = s.y ?? 0;
      linePos[o + 2] = s.z ?? 0;
      linePos[o + 3] = t.x ?? 0;
      linePos[o + 4] = t.y ?? 0;
      linePos[o + 5] = t.z ?? 0;
    }
    (lineGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  const C_BASE = new THREE.Color(T().linkBase);
  const C_LIT = new THREE.Color(T().linkLit);
  const C_OUT = new THREE.Color(T().linkOut); // outside focus: nearly background
  function updateLinkColors() {
    for (let i = 0; i < L; i++) {
      const l = data.links[i];
      let c = C_BASE;
      if (isLit(l)) c = C_LIT;
      else if (selected && !(inFocus(endNode(l.source).id) && inFocus(endNode(l.target).id)))
        c = C_OUT;
      const o = i * 6;
      lineCol[o] = lineCol[o + 3] = c.r;
      lineCol[o + 1] = lineCol[o + 4] = c.g;
      lineCol[o + 2] = lineCol[o + 5] = c.b;
    }
    (lineGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }

  graph.onEngineTick(updateLinkPositions);
  // capture/debug hook: scripts/capture.ts frames the camera through this,
  // and waits on `settled` before shooting a freshly-simulated vault.
  const dbg = { graph, settled: false };
  (window as unknown as { __akasha: typeof dbg }).__akasha = dbg;

  graph.onEngineStop(() => {
    updateLinkPositions();
    saveLayout();
    dbg.settled = true;
  });
  graph.onNodeDrag(() => updateLinkPositions());
  // Cached-layout boots never tick the engine; draw the buffer directly.
  setTimeout(() => {
    updateLinkPositions();
    updateLinkColors();
    applyNodeColors();
  }, 0);

  // Persist the settled layout so the next load skips the physics warm-up.
  let layoutSaved = !!cachedPositions;
  function saveLayout() {
    if (layoutSaved) return;
    layoutSaved = true;
    const positions: Record<string, number[]> = {};
    for (const n of data.nodes) {
      positions[n.id] = [
        Math.round((n.x ?? 0) * 10) / 10,
        Math.round((n.y ?? 0) * 10) / 10,
        Math.round((n.z ?? 0) * 10) / 10,
      ];
    }
    fetch("/api/layout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fingerprint: data.meta.fingerprint, positions }),
    }).catch(() => {});
  }

  function repaint() {
    applyNodeColors(); // custom node objects: colors applied directly
    graph.linkVisibility(graph.linkVisibility()); // lit set changed
    updateLinkColors();
  }

  function refreshVisibility() {
    graph.nodeVisibility(graph.nodeVisibility());
    graph.linkVisibility(graph.linkVisibility());
    updateLinkPositions();
    updateLinkColors();
  }

  // ---- node filters ----
  function loadFilters(): Filter[] {
    try {
      const raw = JSON.parse(localStorage.getItem("akasha-filters") || "[]");
      if (Array.isArray(raw))
        return raw.filter(
          (f) => f && (f.mode === "show" || f.mode === "ignore") && typeof f.pattern === "string"
        );
    } catch {
      /* ignore corrupt value */
    }
    return [];
  }
  function saveFilters() {
    localStorage.setItem("akasha-filters", JSON.stringify(filters));
  }

  // A node's searchable text: title, group (pillar/tag), and its #tags.
  function filterFields(n: GNode): string[] {
    return [n.title || "", groupOf(n) || "", ...(n.tags || [])].map((s) => s.toLowerCase());
  }
  // needle's chars appear in order within hay (loose fuzzy match).
  function subsequence(needle: string, hay: string): boolean {
    let i = 0;
    for (let j = 0; j < hay.length && i < needle.length; j++) if (hay[j] === needle[i]) i++;
    return i === needle.length;
  }
  // Compile a pattern to a node predicate: wildcards (*, ?) glob-match a field
  // end to end (macro* = starts with macro); plain text is substring-or-fuzzy.
  function compileMatcher(pattern: string): (n: GNode) => boolean {
    const p = pattern.trim().toLowerCase();
    if (!p) return () => false;
    if (/[*?]/.test(p)) {
      const re = new RegExp(
        "^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"
      );
      return (n) => filterFields(n).some((f) => re.test(f));
    }
    return (n) => {
      const fs = filterFields(n);
      return fs.some((f) => f.includes(p)) || (p.length >= 3 && subsequence(p, fs[0]));
    };
  }

  // The active chain = persisted filters, plus the live input as a low-priority
  // preview at the end so typing shows its effect before you commit it.
  function activeChain(): Filter[] {
    return liveFilter && liveFilter.pattern.trim() ? [...filters, liveFilter] : filters;
  }
  // Recompute which nodes the chain hides, then refresh the scene. First rule to
  // match a node decides it (show -> keep, ignore -> hide). A node matched by no
  // rule is hidden when any show rule exists (show acts as a whitelist).
  function applyFilters() {
    const chain = activeChain();
    filterHidden = new Set<string>();
    if (chain.length) {
      const hasShow = chain.some((f) => f.mode === "show");
      const rules = chain.map((f) => ({ keep: f.mode === "show", test: compileMatcher(f.pattern) }));
      for (const n of data.nodes) {
        let keep = !hasShow;
        for (const r of rules) {
          if (r.test(n)) {
            keep = r.keep;
            break;
          }
        }
        if (!keep) filterHidden.add(n.id);
      }
    }
    refreshVisibility();
    repaint();
  }

  // ---- persistent node labels (Obsidian-style) ----
  // Every node carries a text sprite; a per-frame loop fades each label by
  // its distance to the camera, so names appear as you approach, matching
  // Obsidian's behavior in 3D. Selection/hover force labels on.
  let labelsOn = true;
  let labelDist = 700; // world units at which a label has fully faded out
  let labelSize = 4;
  const sprites = new Map<string, SpriteText>();

  // SpriteText is a THREE.Sprite at runtime; its d.ts doesn't expose that.
  type SpriteRT = {
    visible: boolean;
    renderOrder: number;
    material: { transparent: boolean; opacity: number; depthWrite: boolean; depthTest: boolean };
    position: { set(x: number, y: number, z: number): void };
    center: { set(x: number, y: number): void };
  };

  function spriteFor(n: GNode): SpriteText {
    let sprite = sprites.get(n.id);
    if (!sprite) {
      sprite = new SpriteText(n.title);
      sprite.color = T().labels.color;
      sprite.textHeight = labelSize;
      // contrast chip: subtle plate + hairline border against the background
      sprite.backgroundColor = T().labels.bg;
      sprite.padding = 1.6;
      sprite.borderColor = T().labels.border;
      sprite.borderWidth = 0.3;
      sprite.borderRadius = 2;
      const rt = sprite as unknown as SpriteRT;
      rt.material.transparent = true;
      rt.material.depthWrite = false;
      rt.material.depthTest = false; // never occluded by the node's own sphere
      rt.renderOrder = 2;
      // anchor at the node center, hang below it in *screen space*: the label
      // tracks the camera from any angle instead of living at a world offset
      rt.position.set(0, 0, 0);
      rt.center.set(0.5, 1.35);
      sprites.set(n.id, sprite);
    }
    return sprite;
  }

  // ---- node styles: classic / dodecahedron / starlight ----
  // Custom per-node objects replace the library's default spheres so the
  // style can change geometry, material, and glow. The label sprite rides
  // along inside each node's group.
  type NodeStyle = "classic" | "dodecahedron" | "starlight" | "particles";
  let nodeStyle = (new URLSearchParams(window.location.search).get("nodes") ||
    localStorage.getItem("akasha-nodes") ||
    "classic") as NodeStyle;
  if ((nodeStyle as string) === "crystal") nodeStyle = "dodecahedron"; // pre-rename saved setting
  if (!["classic", "dodecahedron", "starlight", "particles"].includes(nodeStyle)) nodeStyle = "classic";

  let sizeFactor = 4; // node-size slider (matches the lib's default nodeRelSize)

  // ---- weighted node sizing: incoming links, outgoing links, words ----
  // Each factor is log-normalized against the vault max (counts are heavy-
  // tailed; raw scaling would make a few hubs flatten everything else),
  // then blended by user-adjustable weights.
  const sizeWeights: { in: number; out: number; words: number; contrast: number } = {
    in: 1,
    out: 0.5,
    words: 0.5,
    contrast: 1.5,
    ...JSON.parse(localStorage.getItem("akasha-size-weights") ?? "{}"),
  };
  let maxLogIn = 1;
  let maxLogOut = 1;
  let maxLogWords = 1;
  function computeSizeNorms() {
    maxLogIn = maxLogOut = maxLogWords = 1;
    for (const n of data.nodes) {
      maxLogIn = Math.max(maxLogIn, Math.log1p(n.in));
      maxLogOut = Math.max(maxLogOut, Math.log1p(n.out));
      maxLogWords = Math.max(maxLogWords, Math.log1p(n.words));
    }
  }
  computeSizeNorms();

  const radiusOf = (n: GNode) => {
    const wSum = sizeWeights.in + sizeWeights.out + sizeWeights.words || 1;
    const score =
      (sizeWeights.in * (Math.log1p(n.in) / maxLogIn) +
        sizeWeights.out * (Math.log1p(n.out) / maxLogOut) +
        sizeWeights.words * (Math.log1p(n.words) / maxLogWords)) /
      wSum;
    // power curve (same normalization idea as the particle energy scaling):
    // contrast 1 = linear; higher pushes mid-scored notes down so hubs pop
    return (0.5 + 4.0 * Math.pow(score, sizeWeights.contrast)) * sizeFactor;
  };

  // rescale every existing node object (slider / weight changes)
  function rescaleNodes() {
    for (const [id, mesh] of meshOf) {
      const n = byId.get(id);
      if (!n) continue;
      const r = radiusOf(n);
      mesh.scale.setScalar(
        nodeStyle === "starlight" ? r * 0.65 : nodeStyle === "particles" ? r * 1.25 : r
      );
      if (nodeStyle === "particles") {
        (mesh.material as THREE.PointsMaterial).size = r * 0.22 * pcSizeNorm();
        const pair = spinOf.get(id);
        if (pair) {
          pair.core.scale.setScalar(r * 1.25);
          (pair.core.material as THREE.PointsMaterial).size = r * 0.34 * pcSizeNorm();
        }
      }
      glowOf.get(id)?.scale.setScalar(r * 3);
    }
  }

  // shared geometries (unit-sized; scaled per node)
  const sphereGeo = () => new THREE.SphereGeometry(1, QUALITY[quality].nodeRes, Math.max(4, QUALITY[quality].nodeRes / 2));
  // detail stays 0 at every tier; subdividing would round away the 12 pentagonal faces
  const dodecaGeo = () => new THREE.DodecahedronGeometry(1, 0);

  // ---- particle clouds: volumetric, glowing, gravitationally swirling ----
  // Two shared geometries per count: a dense CORE (gravity well; density
  // rises toward the center) and an outer HALO. Each node instances both and
  // they counter-rotate at different speeds, reading as orbital motion.
  // "auto" follows the graphics tier (measured: vertex count is cheap; a modern
  // discrete GPU holds ~55fps from 256 to 16,384/node; the cost lives in
  // draw calls + close-range fill rate, so tiers map to GPU class).
  const pcExplicit =
    new URLSearchParams(window.location.search).get("pc") || localStorage.getItem("akasha-pc");
  const tierPc = () => QUALITY[quality].pc;
  let particleCount =
    pcExplicit && pcExplicit !== "auto" ? Number(pcExplicit) : tierPc();
  // ?pc= accepts any value for benchmarking/power users (clamped to keep the tab alive)
  particleCount = Math.max(16, Math.min(32768, particleCount || tierPc()));

  const particleCloud = (count: number, rPow: number, rMin: number, rMax: number) => {
    const pos = new Float32Array(count * 3);
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < count; i++) {
      const y = 1 - (i / Math.max(1, count - 1)) * 2;
      const rXZ = Math.sqrt(1 - y * y);
      const a = golden * i + Math.random() * 0.35;
      // radius ~ u^rPow: small exponents pull density toward the center
      const r = rMin + (rMax - rMin) * Math.pow(Math.random(), rPow);
      pos[i * 3] = Math.cos(a) * rXZ * r;
      pos[i * 3 + 1] = y * r * 0.75; // slight flattening for a disc-like swirl
      pos[i * 3 + 2] = Math.sin(a) * rXZ * r;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    return geo;
  };
  let coreGeo = particleCloud(Math.round(particleCount * 0.45), 1.8, 0.05, 0.55);
  let haloGeo = particleCloud(Math.round(particleCount * 0.55), 0.6, 0.35, 1.0);
  const spinOf = new Map<string, { core: THREE.Points; halo: THREE.Points }>();

  // Energy conservation across particle counts: total emitted light scales
  // with count × size² × opacity, so higher counts get finer, fainter motes
  // (size ∝ f^-0.25, opacity ∝ f^-0.5): same overall glow, more depth.
  const pcF = () => particleCount / 256;
  const pcSizeNorm = () => Math.pow(pcF(), -0.25);
  const pcOpacityNorm = () => Math.pow(pcF(), -0.5);

  // soft radial glow texture for starlight halos
  const glowTex = (() => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d")!;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    // gentle falloff: thousands of these overlap additively at distance,
    // so the per-halo energy must stay low or the field blows out white
    grad.addColorStop(0, "rgba(255,255,255,0.5)");
    grad.addColorStop(0.3, "rgba(255,255,255,0.14)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  })();

  const meshOf = new Map<string, THREE.Mesh | THREE.Points>();
  const glowOf = new Map<string, THREE.Sprite>();
  let geoShared: THREE.BufferGeometry = nodeStyle === "dodecahedron" ? dodecaGeo() : sphereGeo();

  graph.nodeThreeObjectExtend(false).nodeThreeObject((n: GNode) => {
    const group = new THREE.Group();
    const r = radiusOf(n);
    let mesh: THREE.Mesh | THREE.Points;
    if (nodeStyle === "particles") {
      // glowing volumetric cloud: bright core + counter-rotating halo
      const glowMat = (size: number, opacity: number) =>
        new THREE.PointsMaterial({
          map: glowTex,
          size,
          transparent: true,
          opacity,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          sizeAttenuation: true,
        });
      const core = new THREE.Points(coreGeo, glowMat(r * 0.34 * pcSizeNorm(), 0.85 * pcOpacityNorm()));
      const halo = new THREE.Points(haloGeo, glowMat(r * 0.22 * pcSizeNorm(), 0.5 * pcOpacityNorm()));
      core.scale.setScalar(r * 1.25);
      halo.scale.setScalar(r * 1.25);
      // per-node phase + tilt so the field doesn't spin in lockstep
      const seed = (n.id.charCodeAt(0) * 31 + n.id.length * 7) % 100;
      core.rotation.set(0.3, (seed / 100) * Math.PI * 2, 0);
      halo.rotation.set(-0.2, ((seed + 37) / 100) * Math.PI * 2, 0);
      group.add(core);
      group.add(halo);
      spinOf.set(n.id, { core, halo });
      mesh = halo; // color/recolor path tracks the halo; core handled via spinOf
    } else if (nodeStyle === "dodecahedron") {
      mesh = new THREE.Mesh(
        geoShared,
        new THREE.MeshStandardMaterial({ flatShading: true, metalness: 0.25, roughness: 0.4 })
      );
      mesh.scale.setScalar(r);
    } else if (nodeStyle === "starlight") {
      mesh = new THREE.Mesh(geoShared, new THREE.MeshBasicMaterial()); // self-lit core
      mesh.scale.setScalar(r * 0.65);
      const glow = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: glowTex,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        })
      );
      glow.scale.setScalar(r * 3);
      group.add(glow);
      glowOf.set(n.id, glow);
    } else {
      mesh = new THREE.Mesh(geoShared, new THREE.MeshLambertMaterial());
      mesh.scale.setScalar(r);
    }
    meshOf.set(n.id, mesh);
    if (!mesh.parent) group.add(mesh); // particles already added their pair
    group.add(spriteFor(n) as unknown as THREE.Object3D);
    return group as never;
  });

  // rgba()/hex -> color + alpha (dim states use rgba strings)
  const RGBA_RE = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/;
  const WHITE = new THREE.Color(1, 1, 1);
  const parseColor = (s: string): { color: THREE.Color; opacity: number } => {
    const m = s.match(RGBA_RE);
    if (m) {
      return {
        color: new THREE.Color(+m[1] / 255, +m[2] / 255, +m[3] / 255),
        opacity: m[4] !== undefined ? +m[4] : 1,
      };
    }
    return { color: new THREE.Color(s), opacity: 1 };
  };

  function applyNodeColors() {
    for (const n of data.nodes) {
      const mesh = meshOf.get(n.id);
      if (!mesh) continue;
      const { color, opacity } = parseColor(nodeColor(n));
      // Lambert/Basic/Points materials all share color/transparent/opacity
      const mat = mesh.material as THREE.MeshLambertMaterial;
      mat.color.copy(color);
      if (nodeStyle === "particles") {
        mat.opacity = 0.5 * pcOpacityNorm() * opacity;
        const pair = spinOf.get(n.id);
        if (pair) {
          // gravity-well core: white-hot center in the group's hue
          const coreMat = pair.core.material as THREE.PointsMaterial;
          coreMat.color.copy(color).lerp(WHITE, 0.45);
          coreMat.opacity = 0.85 * pcOpacityNorm() * opacity;
        }
      } else {
        mat.transparent = opacity < 1;
        mat.opacity = opacity;
      }
      const glow = glowOf.get(n.id);
      if (glow) {
        glow.material.color.copy(color);
        glow.material.opacity = 0.2 + 0.55 * opacity;
        glow.visible = opacity > 0.5; // dimmed stars lose their halo
      }
    }
  }

  function rebuildNodes() {
    // three.js frees GPU buffers only on dispose(); without it,
    // every style/quality/count switch strands the old geometries and ~1.8k
    // per-node materials in VRAM. (glowTex is shared and deliberately kept.)
    for (const mesh of meshOf.values()) (mesh.material as THREE.Material).dispose();
    for (const { core } of spinOf.values()) (core.material as THREE.Material).dispose();
    for (const glow of glowOf.values()) glow.material.dispose();
    geoShared.dispose();
    coreGeo.dispose();
    haloGeo.dispose();

    meshOf.clear();
    glowOf.clear();
    spinOf.clear();
    geoShared = nodeStyle === "dodecahedron" ? dodecaGeo() : sphereGeo();
    coreGeo = particleCloud(Math.round(particleCount * 0.45), 1.8, 0.05, 0.55);
    haloGeo = particleCloud(Math.round(particleCount * 0.55), 0.6, 0.35, 1.0);
    graph.nodeThreeObject(graph.nodeThreeObject()); // force object re-creation
    coloredCount = -1; // the fade loop recolors as the set repopulates
    applyNodeColors();
  }

  // ---- dynamic key light: front-view shading that follows the camera,
  // and radiates from the selected node when one is chosen ----
  const keyLight = new THREE.PointLight(0xffffff, 1.1);
  keyLight.decay = 0; // constant illumination across the graph's scale
  graph.scene().add(keyLight);

  // Label budget: at most this many ambient labels draw at once (the nearest
  // win). Selection/hover labels are always shown on top of the budget.
  let maxLabels = QUALITY[quality].labels;
  const cam = graph.camera();
  let labelFrame = 0;
  // ---- FPS instrumentation (?fps=1 overlay; ?fpsreport=1 posts to server) ----
  const qp = new URLSearchParams(window.location.search);
  let fpsDiv: HTMLElement | null = null;
  if (qp.get("fps")) {
    fpsDiv = document.createElement("div");
    fpsDiv.style.cssText =
      "position:fixed;top:54px;right:16px;z-index:99;font:600 16px Consolas,monospace;" +
      "color:#7ee787;background:rgba(0,0,0,0.6);padding:4px 10px;border-radius:6px";
    document.body.appendChild(fpsDiv);
  }
  let fpsFrames = 0;
  let fpsWindowStart = performance.now();
  const fpsReport = !!qp.get("fpsreport");
  const reportSamples: number[] = [];
  const reportStart = performance.now();
  let reported = false;

  let coloredCount = -1;
  function fadeLabels() {
    requestAnimationFrame(fadeLabels);

    // fps accounting (1s windows)
    fpsFrames++;
    const nowMs = performance.now();
    if (nowMs - fpsWindowStart >= 1000) {
      const fps = (fpsFrames * 1000) / (nowMs - fpsWindowStart);
      fpsFrames = 0;
      fpsWindowStart = nowMs;
      if (fpsDiv) fpsDiv.textContent = `${fps.toFixed(0)} fps`;
      if (fpsReport && nowMs - reportStart > 4000) reportSamples.push(fps); // skip warm-up
      if (fpsReport && !reported && reportSamples.length >= 6) {
        reported = true;
        const avg = reportSamples.reduce((a, b) => a + b, 0) / reportSamples.length;
        fetch("/api/fpslog", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fps: Math.round(avg * 10) / 10,
            nodes: nodeStyle,
            pc: particleCount,
            quality,
          }),
        }).catch(() => {});
      }
    }

    // gravity swirl: counter-rotating core/halo, Keplerian feel (core faster)
    if (nodeStyle === "particles") {
      for (const { core, halo } of spinOf.values()) {
        core.rotation.y += 0.012;
        halo.rotation.y -= 0.004;
      }
    }
    // dynamic key light: front-view shading from the camera, or radiating
    // outward from the selected node (every frame, so the light stays smooth)
    if (selected) {
      keyLight.position.set(selected.x ?? 0, selected.y ?? 0, selected.z ?? 0);
      keyLight.intensity = 2.4;
    } else {
      keyLight.position.copy(cam.position);
      keyLight.intensity = 1.1;
    }
    if (labelFrame++ % 2 !== 0) return; // 30Hz is plenty for opacity fades
    // node objects are created asynchronously by the library (and hidden
    // phantoms may never be); recolor whenever the created set grows
    if (meshOf.size !== coloredCount) {
      coloredCount = meshOf.size;
      applyNodeColors();
    }
    const candidates: Array<{ rt: SpriteRT; o: number }> = [];
    for (const [id, sprite] of sprites) {
      const n = byId.get(id);
      if (!n) continue;
      const rt = sprite as unknown as SpriteRT;
      const dx = (n.x ?? 0) - cam.position.x;
      const dy = (n.y ?? 0) - cam.position.y;
      const dz = (n.z ?? 0) - cam.position.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      let o = labelsOn ? Math.max(0, 1 - dist / labelDist) : 0;
      let forced = false;
      if (selected) {
        if (id === selected.id) {
          o = 1;
          forced = true;
        } else if (neighbors.get(selected.id)?.has(id)) {
          o = Math.max(o, 0.95);
          forced = true;
        } else if (!inFocus(id)) o = 0;
      } else if (hoverNode) {
        if (id === hoverNode.id) {
          o = 1;
          forced = true;
        } else if (neighbors.get(hoverNode.id)?.has(id)) {
          o = Math.max(o, 0.85);
          forced = true;
        }
      }
      if (forced) {
        rt.visible = true;
        rt.material.opacity = o;
      } else if (o > 0.04) {
        rt.visible = false; // provisional; winners flip back on below
        candidates.push({ rt, o });
      } else {
        rt.visible = false;
      }
    }
    candidates.sort((a, b) => b.o - a.o);
    const n = Math.min(candidates.length, maxLabels);
    for (let i = 0; i < n; i++) {
      candidates[i].rt.visible = true;
      candidates[i].rt.material.opacity = candidates[i].o;
    }
  }
  requestAnimationFrame(fadeLabels);

  function flyTo(n: GNode, ms = 1200) {
    const d = 130;
    const len = Math.hypot(n.x ?? 1, n.y ?? 1, n.z ?? 1) || 1;
    const k = 1 + d / len;
    graph.cameraPosition(
      { x: (n.x ?? 0) * k, y: (n.y ?? 0) * k, z: (n.z ?? 0) * k },
      { x: n.x ?? 0, y: n.y ?? 0, z: n.z ?? 0 },
      ms
    );
  }

  function select(n: GNode) {
    selected = n;
    focusSet = bfs(n.id, focusDepth);
    flyTo(n);
    repaint();
    openReader(n);
  }

  function clearSelection() {
    selected = null;
    focusSet = null;
    repaint();
    $("#reader").classList.add("hidden");
  }

  // --- reader panel ---
  async function openReader(n: GNode) {
    const reader = $("#reader");
    $("#reader-title").textContent = n.title;
    $("#reader-path").textContent = n.phantom ? "unwritten — linked but not yet created" : n.id;
    reader.classList.remove("hidden");
    const body = $("#reader-body");
    if (n.phantom) {
      body.innerHTML = `<p class="muted">This note doesn't exist yet. ${
        neighbors.get(n.id)?.size ?? 0
      } note(s) link to it.</p>`;
      return;
    }
    body.innerHTML = '<p class="muted">loading…</p>';
    try {
      const res = await fetch(`/api/note?id=${encodeURIComponent(n.id)}`);
      const { markdown } = await res.json();
      // Strip a leading OKF/YAML frontmatter block so it isn't rendered raw
      // (the node title/type already came from it via the scanner).
      const stripped = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
      // [[wiki links]] -> in-app navigation spans
      const prepped = stripped.replace(
        /\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/g,
        (_m: string, target: string, alias?: string) =>
          `<a class="wiki" data-target="${target.trim().replace(/"/g, "&quot;")}">${alias ?? target}</a>`
      );
      body.innerHTML = await marked.parse(prepped);
    } catch {
      body.innerHTML = '<p class="muted">could not load note</p>';
    }
  }

  $("#reader-body").addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest("a.wiki") as HTMLElement | null;
    if (!a) return;
    const t = (a.dataset.target ?? "").toLowerCase();
    const node = byBasename.get(t.split("/").pop()!) ?? byId.get(`phantom:${t}`);
    if (node) select(node);
  });

  $("#reader-close").addEventListener("click", clearSelection);

  // ---- reader panel: draggable (header) + resizable (edge/corner) ----
  // Docked = pinned to the right edge, full height, width adjustable.
  // Dragging the header undocks it into a floating window; double-click
  // the header to re-dock. Geometry persists per browser.
  {
    const reader = $("#reader");
    interface ReaderGeom {
      floating: boolean;
      width: number;
      height: number;
      left: number;
      top: number;
    }
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

    const saved: ReaderGeom | null = JSON.parse(localStorage.getItem("akasha-reader") ?? "null");
    const geom: ReaderGeom = saved ?? {
      floating: false,
      width: Math.min(440, window.innerWidth * 0.42),
      height: window.innerHeight * 0.7,
      left: 80,
      top: 60,
    };
    const persist = () => localStorage.setItem("akasha-reader", JSON.stringify(geom));

    function applyGeom() {
      geom.width = clamp(geom.width, 280, window.innerWidth - 40);
      reader.style.width = geom.width + "px";
      reader.classList.toggle("floating", geom.floating);
      if (geom.floating) {
        geom.height = clamp(geom.height, 220, window.innerHeight - 24);
        geom.left = clamp(geom.left, 12 - geom.width + 80, window.innerWidth - 80);
        geom.top = clamp(geom.top, 0, window.innerHeight - 48);
        reader.style.left = geom.left + "px";
        reader.style.top = geom.top + "px";
        reader.style.height = geom.height + "px";
        reader.style.right = "auto";
        reader.style.bottom = "auto";
      } else {
        reader.style.left = "auto";
        reader.style.top = "0";
        reader.style.right = "0";
        reader.style.bottom = "0";
        reader.style.height = "auto";
      }
    }
    applyGeom();

    // generic pointer-drag helper (pointer capture handles mouseup outside)
    const dragOp = (
      onMove: (dx: number, dy: number) => void,
      cls: "dragging" | "resizing"
    ) => (down: PointerEvent) => {
      down.preventDefault();
      const startX = down.clientX;
      const startY = down.clientY;
      const el = down.currentTarget as HTMLElement;
      el.setPointerCapture(down.pointerId);
      reader.classList.add(cls);
      const move = (e: PointerEvent) => onMove(e.clientX - startX, e.clientY - startY);
      const up = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        reader.classList.remove(cls);
        persist();
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
    };

    // left-edge: width resize (works docked and floating)
    {
      let w0 = 0;
      let l0 = 0;
      const handle = $("#reader-resize-w");
      handle.addEventListener("pointerdown", (e: PointerEvent) => {
        w0 = geom.width;
        l0 = geom.left;
        dragOp((dx) => {
          if (geom.floating) {
            // left edge moves; right edge stays put
            geom.width = w0 - dx;
            geom.left = l0 + dx;
          } else {
            geom.width = w0 - dx;
          }
          applyGeom();
        }, "resizing")(e);
      });
    }

    // corner grip (floating only): both dimensions
    {
      let w0 = 0;
      let h0 = 0;
      const handle = $("#reader-resize-corner");
      handle.addEventListener("pointerdown", (e: PointerEvent) => {
        w0 = geom.width;
        h0 = geom.height;
        dragOp((dx, dy) => {
          geom.width = w0 + dx;
          geom.height = h0 + dy;
          applyGeom();
        }, "resizing")(e);
      });
    }

    // header: drag to move (undocks on first drag), dbl-click to re-dock
    {
      let l0 = 0;
      let t0 = 0;
      const head = $("#reader-head");
      head.addEventListener("pointerdown", (e: PointerEvent) => {
        if ((e.target as HTMLElement).closest("button")) return; // buttons stay buttons
        if (!geom.floating) {
          // undock in place: adopt the current docked rect
          const r = reader.getBoundingClientRect();
          geom.floating = true;
          geom.left = r.left;
          geom.top = r.top;
          geom.height = r.height - 24;
          applyGeom();
        }
        l0 = geom.left;
        t0 = geom.top;
        dragOp((dx, dy) => {
          geom.left = l0 + dx;
          geom.top = t0 + dy;
          applyGeom();
        }, "dragging")(e);
      });
      head.addEventListener("dblclick", (e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        geom.floating = false;
        applyGeom();
        persist();
      });
    }

    window.addEventListener("resize", applyGeom);
  }

  // --- open in Obsidian ---
  const openInObsidian = (n: GNode) => {
    if (n.phantom) return;
    const file = n.id.replace(/\.md$/i, "");
    window.location.href = `obsidian://open?vault=${encodeURIComponent(
      data.meta.vaultName
    )}&file=${encodeURIComponent(file)}`;
  };
  $("#open-obsidian").addEventListener("click", () => selected && openInObsidian(selected));
  graph.onNodeRightClick((n: GNode) => openInObsidian(n));
  let lastClick = 0;
  let lastClickId = "";
  graph.onNodeClick((n: GNode) => {
    const now = Date.now();
    if (n.id === lastClickId && now - lastClick < 350) openInObsidian(n);
    else select(n);
    lastClick = now;
    lastClickId = n.id;
  });

  // --- topbar stats ---
  $("#brand-stats").textContent = `${data.meta.notes.toLocaleString()} notes · ${data.meta.links.toLocaleString()} links`;

  // --- legend (rebuilt on theme/group/color changes) ---
  // Each swatch is a color picker: pick your own group colors, persisted.
  function buildLegend() {
    const legend = $("#legend");
    legend.innerHTML = "";
    for (const g of groups) {
      if (g === "Unwritten") continue;
      const row = document.createElement("div");
      row.className = "legend-row";
      row.classList.toggle("off", pillarOn[g] === false);
      row.innerHTML =
        `<input type="color" class="dot-pick" value="${colorOf[g]}" title="Pick a color for ${g}">` +
        `<span class="legend-name">${g}</span><span class="count">${groupCounts.get(g) ?? 0}</span>`;
      const pick = row.querySelector(".dot-pick") as HTMLInputElement;
      pick.addEventListener("click", (e) => e.stopPropagation());
      pick.addEventListener("input", () => {
        customColors[g] = pick.value;
        localStorage.setItem("akasha-colors", JSON.stringify(customColors));
        recomputeColors();
        repaint();
      });
      row.addEventListener("click", () => {
        pillarOn[g] = pillarOn[g] === false;
        row.classList.toggle("off", pillarOn[g] === false);
        refreshVisibility();
      });
      legend.appendChild(row);
    }
  }
  buildLegend();

  // --- group-by mode (folder structure vs #tags) ---
  ($("#group") as HTMLSelectElement).value = groupMode;
  ($("#group") as HTMLSelectElement).addEventListener("change", (e) => {
    groupMode = (e.target as HTMLSelectElement).value as "folder" | "tag";
    localStorage.setItem("akasha-group", groupMode);
    for (const k of Object.keys(pillarOn)) delete pillarOn[k]; // all visible again
    computeGroups();
    recomputeColors();
    buildLegend();
    refreshVisibility();
    repaint();
  });
  $("#reset-colors").addEventListener("click", () => {
    for (const k of Object.keys(customColors)) delete customColors[k];
    localStorage.removeItem("akasha-colors");
    recomputeColors();
    buildLegend();
    repaint();
  });

  // --- controls ---
  ($("#toggle-phantoms") as HTMLInputElement).addEventListener("change", (e) => {
    showPhantoms = (e.target as HTMLInputElement).checked;
    refreshVisibility();
  });
  ($("#toggle-orphans") as HTMLInputElement).addEventListener("change", (e) => {
    showOrphans = (e.target as HTMLInputElement).checked;
    refreshVisibility();
  });
  ($("#toggle-glow") as HTMLInputElement).addEventListener("change", (e) => {
    glowOn = (e.target as HTMLInputElement).checked;
    bloom.enabled = glowOn && QUALITY[quality].bloom;
  });
  const gfxSel = $("#gfx") as HTMLSelectElement;
  gfxSel.value = quality;
  gfxSel.addEventListener("change", () => applyQuality(gfxSel.value as QKey));

  const themeSel = $("#theme") as HTMLSelectElement;
  themeSel.value = theme;
  themeSel.addEventListener("change", () => applyTheme(themeSel.value));
  applyTheme(theme); // sync CSS vars + scene for the persisted choice

  const nodesSel = $("#nodes") as HTMLSelectElement;
  nodesSel.value = nodeStyle;
  nodesSel.addEventListener("change", () => {
    nodeStyle = nodesSel.value as NodeStyle;
    localStorage.setItem("akasha-nodes", nodeStyle);
    rebuildNodes();
  });
  ($("#toggle-labels") as HTMLInputElement).addEventListener("change", (e) => {
    labelsOn = (e.target as HTMLInputElement).checked;
  });

  // ---- filters panel ----
  $("#filters-btn").addEventListener("click", () => $("#filters").classList.toggle("hidden"));
  {
    const modeBtn = $("#filter-mode") as HTMLButtonElement;
    const input = $("#filter-input") as HTMLInputElement;
    const list = $("#filter-list");
    let liveMode: "show" | "ignore" = "show";
    let dragFrom = -1;
    let debounce = 0;

    function renderFilters() {
      list.innerHTML = "";
      filters.forEach((f, i) => {
        const row = document.createElement("div");
        row.className = "filter-row";
        row.draggable = true;

        const handle = document.createElement("span");
        handle.className = "filter-drag";
        handle.textContent = "⠿";
        handle.title = "Drag to reorder";

        const mode = document.createElement("button");
        mode.className = "filter-mode";
        mode.dataset.mode = f.mode;
        mode.textContent = f.mode;
        mode.title = "Toggle show / ignore";
        mode.addEventListener("click", () => {
          f.mode = f.mode === "show" ? "ignore" : "show";
          mode.dataset.mode = f.mode;
          mode.textContent = f.mode;
          saveFilters();
          applyFilters();
        });

        const rm = document.createElement("button");
        rm.className = "filter-pm";
        rm.textContent = "−";
        rm.title = "Remove filter";
        rm.addEventListener("click", () => {
          filters.splice(i, 1);
          saveFilters();
          renderFilters();
          applyFilters();
        });

        const pat = document.createElement("span");
        pat.className = "filter-pattern";
        pat.textContent = f.pattern;
        pat.title = f.pattern;

        row.append(handle, mode, rm, pat);

        row.addEventListener("dragstart", () => {
          dragFrom = i;
          row.classList.add("dragging");
        });
        row.addEventListener("dragend", () => {
          dragFrom = -1;
          list.querySelectorAll(".filter-row").forEach((e) => e.classList.remove("dragging", "drop-target"));
        });
        row.addEventListener("dragover", (e) => {
          e.preventDefault();
          row.classList.add("drop-target");
        });
        row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
        row.addEventListener("drop", (e) => {
          e.preventDefault();
          row.classList.remove("drop-target");
          if (dragFrom < 0 || dragFrom === i) return;
          const [moved] = filters.splice(dragFrom, 1);
          filters.splice(i, 0, moved);
          saveFilters();
          renderFilters();
          applyFilters();
        });

        list.appendChild(row);
      });
    }

    const setLive = () => {
      liveFilter = input.value.trim() ? { mode: liveMode, pattern: input.value } : null;
      clearTimeout(debounce);
      debounce = window.setTimeout(applyFilters, 70);
    };
    const commit = () => {
      if (!input.value.trim()) return;
      filters.unshift({ mode: liveMode, pattern: input.value });
      input.value = "";
      liveFilter = null;
      saveFilters();
      renderFilters();
      applyFilters();
      input.focus();
    };

    modeBtn.addEventListener("click", () => {
      liveMode = liveMode === "show" ? "ignore" : "show";
      modeBtn.dataset.mode = liveMode;
      modeBtn.textContent = liveMode;
      if (input.value.trim()) setLive();
    });
    input.addEventListener("input", setLive);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
      }
    });
    $("#filter-add").addEventListener("click", commit);

    renderFilters();
    applyFilters(); // honor persisted filters on load
  }

  // ---- display settings panel ----
  $("#settings-btn").addEventListener("click", () => $("#settings").classList.toggle("hidden"));
  const bindRange = (id: string, fmt: (v: number) => string, apply: (v: number) => void) => {
    const el = $(`#${id}`) as HTMLInputElement;
    el.addEventListener("input", () => {
      const v = Number(el.value);
      $(`#${id}-val`).textContent = fmt(v);
      apply(v);
    });
  };
  bindRange("label-distance", String, (v) => (labelDist = v));
  bindRange("label-size", String, (v) => {
    labelSize = v;
    for (const s of sprites.values()) s.textHeight = v;
  });
  bindRange("node-size", String, (v) => {
    sizeFactor = v;
    rescaleNodes();
  });
  const bindWeight = (id: string, key: "in" | "out" | "words" | "contrast") => {
    const el = $(`#${id}`) as HTMLInputElement;
    el.value = String(sizeWeights[key]);
    $(`#${id}-val`).textContent = sizeWeights[key].toFixed(1);
    el.addEventListener("input", () => {
      sizeWeights[key] = Number(el.value);
      $(`#${id}-val`).textContent = sizeWeights[key].toFixed(1);
      localStorage.setItem("akasha-size-weights", JSON.stringify(sizeWeights));
      rescaleNodes();
    });
  };
  bindWeight("w-in", "in");
  bindWeight("w-out", "out");
  bindWeight("w-words", "words");
  bindWeight("w-contrast", "contrast");

  const pcSel = $("#pc") as HTMLSelectElement;
  pcSel.value = pcExplicit && pcExplicit !== "auto" ? String(particleCount) : "auto";
  if (pcSel.value === "") pcSel.value = "auto"; // value not among presets
  pcSel.addEventListener("change", () => {
    if (pcSel.value === "auto") {
      localStorage.removeItem("akasha-pc");
      particleCount = tierPc();
    } else {
      particleCount = Number(pcSel.value);
      localStorage.setItem("akasha-pc", String(particleCount));
    }
    if (nodeStyle === "particles") rebuildNodes();
  });
  bindRange("link-opacity", (v) => `${v}%`, (v) => (lineMat.opacity = v / 100));
  bindRange("min-weight", String, (v) => {
    minWeight = v;
    refreshVisibility();
  });
  ($("#depth") as HTMLSelectElement).addEventListener("change", (e) => {
    focusDepth = Number((e.target as HTMLSelectElement).value);
    if (selected) {
      focusSet = bfs(selected.id, focusDepth);
      repaint();
    }
  });

  // --- search: instant title matches + indexed full-text content matches ---
  const searchBox = $("#search") as HTMLInputElement;
  const results = $("#search-results");

  const addResult = (n: GNode, snippetText?: string) => {
    const row = document.createElement("div");
    row.className = "result";
    row.innerHTML =
      `<span class="dot" style="background:${colorOf[groupOf(n)]}"></span>` +
      `<span class="result-main"><span>${n.title}</span>` +
      (snippetText ? `<span class="snippet"></span>` : "") +
      `</span><span class="count">${n.pillar}</span>`;
    if (snippetText) (row.querySelector(".snippet") as HTMLElement).textContent = snippetText;
    row.addEventListener("click", () => {
      select(n);
      results.innerHTML = "";
      searchBox.value = "";
    });
    results.appendChild(row);
    return row;
  };

  let searchToken = 0;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  const renderResults = (q: string) => {
    const token = ++searchToken;
    results.innerHTML = "";
    clearTimeout(searchTimer);
    if (!q) return;

    // 1) Title matches: local, instant.
    const ql = q.toLowerCase();
    const shown = new Set<string>();
    const titleHits = data.nodes
      .filter((n) => !n.phantom && n.title.toLowerCase().includes(ql))
      .sort((a, b) => {
        const aStarts = a.title.toLowerCase().startsWith(ql) ? 0 : 1;
        const bStarts = b.title.toLowerCase().startsWith(ql) ? 0 : 1;
        return aStarts - bStarts || degree(b) - degree(a);
      })
      .slice(0, 8);
    for (const n of titleHits) {
      addResult(n);
      shown.add(n.id);
    }

    // 2) Content matches: debounced hit on the server's full-text index.
    searchTimer = setTimeout(async () => {
      try {
        const hits: Array<{ id: string; snippet: string }> = await fetch(
          `/api/search?q=${encodeURIComponent(q)}`
        ).then((r) => r.json());
        if (token !== searchToken) return; // stale response
        for (const h of hits) {
          if (shown.has(h.id) || shown.size >= 16) continue;
          const n = byId.get(h.id);
          if (!n) continue;
          addResult(n, h.snippet);
          shown.add(h.id);
        }
      } catch {
        // index unavailable; title results already shown
      }
    }, 220);
  };
  searchBox.addEventListener("input", () => renderResults(searchBox.value.trim()));
  searchBox.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      (results.firstElementChild as HTMLElement | null)?.click();
    } else if (e.key === "Escape") {
      searchBox.value = "";
      results.innerHTML = "";
      searchBox.blur();
    }
  });

  // ---- menubar (File / View / Tools / Help) ----
  const menus = [...document.querySelectorAll<HTMLElement>(".menu")];
  const closeMenus = () => menus.forEach((m) => m.classList.remove("open"));
  for (const m of menus) {
    const label = m.querySelector(".menu-label") as HTMLElement;
    label.addEventListener("click", (e) => {
      e.stopPropagation();
      const wasOpen = m.classList.contains("open");
      closeMenus();
      if (!wasOpen) m.classList.add("open");
    });
    // standard menubar behavior: once one menu is open, hover switches
    label.addEventListener("mouseenter", () => {
      if (menus.some((x) => x.classList.contains("open")) && !m.classList.contains("open")) {
        closeMenus();
        m.classList.add("open");
      }
    });
  }
  document.addEventListener("click", closeMenus);

  // ---- modal ----
  const showModal = (title: string, html: string) => {
    $("#modal-title").textContent = title;
    $("#modal-body").innerHTML = html;
    $("#modal-backdrop").classList.remove("hidden");
  };
  const hideModal = () => $("#modal-backdrop").classList.add("hidden");
  $("#modal-close").addEventListener("click", hideModal);
  $("#modal-backdrop").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) hideModal();
  });

  // ---- File ----
  async function rescan(full: boolean) {
    closeMenus();
    showModal(
      full ? "Full rescan…" : "Rescanning vault…",
      '<p class="muted">Re-reading the vault and rebuilding the graph…</p>'
    );
    try {
      const r = await fetch(`/api/rescan${full ? "?full=true" : ""}`, { method: "POST" }).then(
        (x) => x.json()
      );
      if (!r.ok) throw new Error(r.error);
      // reload picks up the new graph; the layout cache is fingerprint-keyed,
      // so an unchanged vault comes back instantly with the same layout.
      window.location.reload();
    } catch {
      showModal(
        "Rescan failed",
        "<p>Could not rescan. The server needs access to the original vault path.</p>"
      );
    }
  }
  $("#mi-rescan").addEventListener("click", () => rescan(false));
  $("#mi-rescan-full").addEventListener("click", () => rescan(true));
  $("#mi-reload").addEventListener("click", () => window.location.reload());
  $("#mi-export").addEventListener("click", () => {
    closeMenus();
    const a = document.createElement("a");
    a.download = `akasha-${data.meta.vaultName ?? "vault"}-${new Date().toISOString().slice(0, 10)}.png`;
    a.href = graph.renderer().domElement.toDataURL("image/png");
    a.click();
  });

  // ---- View ----
  $("#mi-fullscreen").addEventListener("click", () => {
    closeMenus();
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen();
  });
  $("#mi-resetcam").addEventListener("click", () => {
    closeMenus();
    clearSelection();
    graph.zoomToFit(1000, 60);
  });
  function syncRadioGroups() {
    for (const b of $("#mi-themes").children) {
      b.classList.toggle("checked", (b as HTMLElement).dataset.key === theme);
    }
    for (const b of $("#mi-gfx").children) {
      b.classList.toggle("checked", (b as HTMLElement).dataset.key === quality);
    }
  }
  for (const [k, t] of Object.entries(THEMES)) {
    const b = document.createElement("button");
    b.dataset.key = k;
    b.textContent = `Theme: ${t.label}`;
    b.addEventListener("click", () => {
      applyTheme(k);
      ($("#theme") as HTMLSelectElement).value = theme;
      syncRadioGroups();
    });
    $("#mi-themes").appendChild(b);
  }
  for (const k of Object.keys(QUALITY) as QKey[]) {
    const b = document.createElement("button");
    b.dataset.key = k;
    b.textContent = `Graphics: ${k}`;
    b.addEventListener("click", () => {
      applyQuality(k);
      ($("#gfx") as HTMLSelectElement).value = k;
      syncRadioGroups();
    });
    $("#mi-gfx").appendChild(b);
  }
  syncRadioGroups();

  // ---- Tools ----
  $("#mi-settings").addEventListener("click", () => {
    closeMenus();
    $("#settings").classList.remove("hidden");
  });
  $("#mi-copyfocus").addEventListener("click", () => {
    closeMenus();
    if (!selected) {
      showModal("No note selected", "<p>Click a node first, then copy a link to it.</p>");
      return;
    }
    navigator.clipboard.writeText(
      `${window.location.origin}/?focus=${encodeURIComponent(selected.title)}`
    );
  });
  $("#mi-obsidian").addEventListener("click", () => {
    closeMenus();
    if (selected) openInObsidian(selected);
    else showModal("No note selected", "<p>Click a node first.</p>");
  });

  // ---- Help ----
  $("#mi-shortcuts").addEventListener("click", () => {
    closeMenus();
    showModal(
      "Keyboard & mouse controls",
      `<table>
        <tr><td>Rotate</td><td>left-drag</td></tr>
        <tr><td>Fly</td><td><kbd>↑</kbd> forward, <kbd>↓</kbd> back, <kbd>←</kbd><kbd>→</kbd> strafe</td></tr>
        <tr><td>Zoom</td><td>scroll, or <kbd>+</kbd> / <kbd>−</kbd></td></tr>
        <tr><td>Pan</td><td>right-drag, or <kbd>Shift</kbd>+arrows</td></tr>
        <tr><td>Search</td><td><kbd>/</kbd>, then <kbd>Enter</kbd> to fly to the top hit</td></tr>
        <tr><td>Select / read note</td><td>click a node</td></tr>
        <tr><td>Open in Obsidian</td><td>double-click or right-click a node</td></tr>
        <tr><td>Clear selection</td><td><kbd>Esc</kbd></td></tr>
        <tr><td>Focus depth</td><td>1–3 in the bottom bar (local-graph radius)</td></tr>
      </table>`
    );
  });
  $("#mi-about").addEventListener("click", () => {
    closeMenus();
    const m = data.meta;
    showModal(
      "About Akasha",
      `<p><b>Akasha</b> — आकाश — your vault as a navigable 3D universe.</p>
       <table>
        <tr><td>Vault</td><td>${m.vaultName ?? "—"}</td></tr>
        <tr><td>Notes</td><td>${m.notes.toLocaleString()}</td></tr>
        <tr><td>Links</td><td>${m.links.toLocaleString()}</td></tr>
        <tr><td>Unwritten targets</td><td>${m.phantoms.toLocaleString()}</td></tr>
        <tr><td>Last scanned</td><td>${new Date(m.scannedAt).toLocaleString()}</td></tr>
       </table>
       <p class="muted" style="margin-bottom:0">MIT licensed · built with three.js</p>`
    );
  });

  // --- global keys: search, clear, and keyboard camera control ---
  // Arrows fly the camera through space (↑ forward, ↓ back, ←/→ strafe),
  // shift+arrows pan, +/- zoom. Rotation stays on mouse left-drag.
  // Held arrows drive a per-frame loop (smooth, frame-rate independent)
  // that accelerates from base speed to FLY_RAMP× over FLY_RAMP_S seconds.
  const FLY_BASE = 1.5; // distance-to-target multiples per second
  const FLY_RAMP = 6; // top speed multiplier once fully ramped
  const FLY_RAMP_S = 5; // seconds of continuous flight to reach top speed
  const heldArrows = new Set<string>();
  let shiftHeld = false;
  let flyStart = 0;

  window.addEventListener("keyup", (e) => {
    if (e.key === "Shift") shiftHeld = false;
    heldArrows.delete(e.key);
  });
  window.addEventListener("blur", () => {
    heldArrows.clear();
    shiftHeld = false;
  });

  let lastFlyFrame = performance.now();
  (function flyTick(now: number) {
    requestAnimationFrame(flyTick);
    const dt = Math.min((now - lastFlyFrame) / 1000, 0.1);
    lastFlyFrame = now;
    if (!heldArrows.size) return;

    const controls = graph.controls() as unknown as { target: THREE.Vector3 };
    const camera = graph.camera();
    const target = controls.target ?? new THREE.Vector3();
    const dist = camera.position.distanceTo(target);
    const ramp = Math.min((now - flyStart) / 1000 / FLY_RAMP_S, 1);
    const step = dist * FLY_BASE * (1 + (FLY_RAMP - 1) * ramp) * dt;

    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
    const delta = new THREE.Vector3();
    if (shiftHeld) {
      // pan: slide camera + target along the screen axes
      const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
      if (heldArrows.has("ArrowLeft")) delta.addScaledVector(right, -step);
      if (heldArrows.has("ArrowRight")) delta.addScaledVector(right, step);
      if (heldArrows.has("ArrowUp")) delta.addScaledVector(up, step);
      if (heldArrows.has("ArrowDown")) delta.addScaledVector(up, -step);
    } else {
      // fly: ↑/↓ move along the view direction, ←/→ strafe. Camera and
      // target move together so orientation (and mouse orbit) is preserved.
      const forward = camera.getWorldDirection(new THREE.Vector3());
      if (heldArrows.has("ArrowUp")) delta.addScaledVector(forward, step);
      if (heldArrows.has("ArrowDown")) delta.addScaledVector(forward, -step);
      if (heldArrows.has("ArrowLeft")) delta.addScaledVector(right, -step);
      if (heldArrows.has("ArrowRight")) delta.addScaledVector(right, step);
    }
    camera.position.add(delta);
    target.add(delta);
  })(lastFlyFrame);

  window.addEventListener("keydown", (e) => {
    const typing = document.activeElement === searchBox;
    if (e.key === "/" && !typing) {
      e.preventDefault();
      searchBox.focus();
      return;
    }
    if (e.key === "Escape" && !typing) {
      // standard escape order: modal, then menus, then selection
      if (!$("#modal-backdrop").classList.contains("hidden")) hideModal();
      else if (menus.some((m) => m.classList.contains("open"))) closeMenus();
      else clearSelection();
      return;
    }
    if (typing) return;

    shiftHeld = e.shiftKey;
    if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      if (e.repeat) return; // the fly loop handles held keys
      if (!heldArrows.size) flyStart = performance.now(); // (re)start the ramp
      heldArrows.add(e.key);
      return;
    }

    const controls = graph.controls() as unknown as { target: THREE.Vector3 };
    const camera = graph.camera();
    const target = controls.target ?? new THREE.Vector3();
    const offset = camera.position.clone().sub(target);

    const sph = new THREE.Spherical().setFromVector3(offset);
    let handled = true;
    switch (e.key) {
      case "+":
      case "=":
        sph.radius *= 0.93;
        break;
      case "-":
      case "_":
        sph.radius *= 1.075;
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      camera.position.copy(target).add(offset.setFromSpherical(sph));
      camera.lookAt(target);
    }
  });

  window.addEventListener("resize", () => {
    graph.width(window.innerWidth).height(window.innerHeight);
  });

  // Deep link: ?focus=<note title> selects and flies to a node once the
  // layout has settled. Shareable views into the map.
  const focusParam = new URLSearchParams(window.location.search).get("focus");
  if (focusParam) {
    const target = byBasename.get(focusParam.toLowerCase());
    if (target) setTimeout(() => select(target), 2500);
  }
}

boot();
