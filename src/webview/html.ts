import { formatDuration, Tone } from '../model';

/**
 * Building blocks of the extension's pages. They draw with the colours and
 * fonts of the current VS Code theme, so the pages look like part of the
 * editor in any theme, light, dark or high contrast.
 */

export function esc(text: string | number | null | undefined): string {
  return String(text ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

const TONE_LABEL: Record<Tone, string> = {
  queued: 'Queued',
  running: 'In progress',
  success: 'Passed',
  failure: 'Failed',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
  neutral: 'Finished',
  attention: 'Needs approval'
};

export function toneLabel(tone: Tone): string {
  return TONE_LABEL[tone];
}

const WHITE = 'var(--al-on-tone)';

/** A 16px status mark, coloured by its tone class. */
export function toneIcon(tone: Tone, size = 16): string {
  const open = `<svg class="ic t-${tone}${tone === 'running' ? ' spin' : ''}" width="${size}" height="${size}" viewBox="0 0 16 16" aria-hidden="true">`;
  switch (tone) {
    case 'success':
      return `${open}<circle cx="8" cy="8" r="7.5" fill="currentColor"/><path d="M4.6 8.3l2.2 2.2 4.6-4.9" stroke="${WHITE}" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    case 'failure':
      return `${open}<circle cx="8" cy="8" r="7.5" fill="currentColor"/><path d="M5.4 5.4l5.2 5.2M10.6 5.4l-5.2 5.2" stroke="${WHITE}" stroke-width="1.7" stroke-linecap="round"/></svg>`;
    case 'running':
      return `${open}<circle cx="8" cy="8" r="6.2" stroke="currentColor" stroke-opacity=".25" stroke-width="2.2" fill="none"/><path d="M8 1.8a6.2 6.2 0 0 1 6.2 6.2" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round"/></svg>`;
    case 'queued':
      return `${open}<circle cx="8" cy="8" r="6.4" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M8 4.6V8l2.3 1.5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>`;
    case 'cancelled':
      return `${open}<circle cx="8" cy="8" r="6.4" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M3.6 12.4l8.8-8.8" stroke="currentColor" stroke-width="1.6"/></svg>`;
    case 'skipped':
      return `${open}<circle cx="8" cy="8" r="6.4" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2.2 2" fill="none"/><path d="M5.5 8h5M8.7 6l2 2-2 2" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    case 'attention':
      return `${open}<circle cx="8" cy="8" r="7.5" fill="currentColor"/><path d="M8 4.4v4.4" stroke="${WHITE}" stroke-width="1.8" stroke-linecap="round"/><circle cx="8" cy="11.4" r="1" fill="${WHITE}"/></svg>`;
    default:
      return `${open}<circle cx="8" cy="8" r="6.4" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>`;
  }
}

const GLYPHS: Record<string, string> = {
  branch: '<path d="M5 3.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zM5 12.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zM14 5.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zM3.5 5v6M12.5 7c0 3-4 2.5-8 4.5" stroke="currentColor" stroke-width="1.3" fill="none"/>',
  commit: '<circle cx="8" cy="8" r="2.6" stroke="currentColor" stroke-width="1.4" fill="none"/><path d="M1 8h4.4M10.6 8H15" stroke="currentColor" stroke-width="1.4"/>',
  clock: '<circle cx="8" cy="8" r="6.3" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M8 4.5V8l2.4 1.6" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/>',
  person: '<circle cx="8" cy="5.2" r="2.8" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M2.5 14.5c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5" stroke="currentColor" stroke-width="1.3" fill="none"/>',
  zap: '<path d="M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/>',
  rerun: '<path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  stop: '<rect x="3.5" y="3.5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.4" fill="none"/>',
  external: '<path d="M9.5 2.5h4v4M13.5 2.5L7.5 8.5M12 9.5v3.5a.5.5 0 0 1-.5.5h-8.5a.5.5 0 0 1-.5-.5V4.5a.5.5 0 0 1 .5-.5H7" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/>',
  sparkle: '<path d="M8 1.5l1.3 3.6 3.7 1.3-3.7 1.3L8 11.3 6.7 7.7 3 6.4l3.7-1.3zM12.5 10.5l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z" fill="currentColor"/>',
  diff: '<path d="M4.5 2v7M1 5.5h7M8 12.5h7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  log: '<path d="M3 2.5h10v11H3zM5.5 5.5h5M5.5 8h5M5.5 10.5h3" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linejoin="round"/>',
  download: '<path d="M8 2v8M4.5 6.8L8 10.3l3.5-3.5M2.5 13.5h11" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  package: '<path d="M2.5 4.8L8 2l5.5 2.8v6.4L8 14l-5.5-2.8zM2.5 4.8L8 7.6l5.5-2.8M8 7.6V14" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/>',
  shield: '<path d="M8 1.5l5.5 2v4c0 3.4-2.3 5.9-5.5 7-3.2-1.1-5.5-3.6-5.5-7v-4z" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linejoin="round"/>',
  warning: '<path d="M8 1.8l6.5 11.7h-13zM8 6.2v3.4M8 11.4v.4" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linejoin="round" stroke-linecap="round"/>',
  file: '<path d="M4 1.5h5.5L12.5 4.5v10H4zM9.5 1.5v3h3" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/>',
  pulse: '<path d="M1 8.5h3l2-5 3.5 9 2-4H15" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  star: '<path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z" fill="currentColor"/>',
  pr: '<circle cx="4" cy="3.5" r="1.6" stroke="currentColor" stroke-width="1.3" fill="none"/><circle cx="4" cy="12.5" r="1.6" stroke="currentColor" stroke-width="1.3" fill="none"/><circle cx="12" cy="12.5" r="1.6" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M4 5.1v5.8M12 10.9V6c0-1.4-1-2.5-2.5-2.5H7M8.6 1.9L7 3.5l1.6 1.6" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
};

export function glyph(name: keyof typeof GLYPHS | string, size = 14): string {
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 16 16" aria-hidden="true">${GLYPHS[name] ?? ''}</svg>`;
}

export interface ButtonOptions {
  cmd: string;
  label: string;
  icon?: string;
  kind?: 'primary' | 'secondary' | 'ghost';
  data?: Record<string, string | number | undefined>;
  pro?: boolean;
  title?: string;
}

export function button(options: ButtonOptions): string {
  const data = Object.entries(options.data ?? {})
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ` data-${key}="${esc(value)}"`)
    .join('');
  return `<button class="btn ${options.kind ?? 'secondary'}" data-cmd="${esc(options.cmd)}"${data}${options.title ? ` title="${esc(options.title)}"` : ''}>${
    options.icon ? glyph(options.icon) : ''
  }<span>${esc(options.label)}</span>${options.pro ? '<span class="pro">PRO</span>' : ''}</button>`;
}

/** A duration that keeps counting in the page while something runs. */
export function liveDuration(startMs: number | undefined, fixedMs: number | undefined, active: boolean): string {
  if (active && startMs !== undefined) {
    return `<span data-since="${startMs}">${esc(formatDuration(Date.now() - startMs))}</span>`;
  }
  return esc(fixedMs !== undefined ? formatDuration(fixedMs) : '—');
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) {
    return '';
  }
  const ms = now - Date.parse(iso);
  const minutes = Math.floor(ms / 60_000);
  if (!Number.isFinite(minutes)) {
    return '';
  }
  const text = minutes < 1 ? 'just now' : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`;
  return `<time title="${esc(new Date(iso).toLocaleString())}">${text}</time>`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export const CSS = `
:root {
  --al-green: var(--vscode-testing-iconPassed, #3fb950);
  --al-red: var(--vscode-testing-iconFailed, #f85149);
  --al-yellow: var(--vscode-charts-yellow, #d29922);
  --al-blue: var(--vscode-charts-blue, #58a6ff);
  --al-gray: var(--vscode-disabledForeground, #8b949e);
  --al-fg: var(--vscode-foreground, #c9d1d9);
  --al-muted: var(--vscode-descriptionForeground, #8b949e);
  --al-bg: var(--vscode-editor-background, #0d1117);
  --al-card: var(--vscode-sideBar-background, var(--vscode-editorWidget-background, #161b22));
  --al-border: var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,.25)));
  --al-hover: var(--vscode-list-hoverBackground, rgba(128,128,128,.12));
  --al-link: var(--vscode-textLink-foreground, #58a6ff);
  --al-code-bg: var(--vscode-textCodeBlock-background, rgba(128,128,128,.12));
  --al-on-tone: #fff;
  --al-radius: 6px;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--al-bg);
  color: var(--al-fg);
  font-family: var(--vscode-font-family, -apple-system, "Segoe UI", sans-serif);
  font-size: var(--vscode-font-size, 13px);
  line-height: 1.45;
}
main { max-width: 1120px; margin: 0 auto; padding: 20px 24px 48px; }
a { color: var(--al-link); text-decoration: none; cursor: pointer; }
a:hover { text-decoration: underline; }
code, .mono { font-family: var(--vscode-editor-font-family, ui-monospace, Consolas, monospace); font-size: .92em; }
h1 { font-size: 1.55em; font-weight: 600; margin: 0; line-height: 1.25; word-break: break-word; }
h2 { font-size: .85em; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--al-muted); margin: 28px 0 10px; display: flex; align-items: center; gap: 8px; }
h2 .count { background: var(--vscode-badge-background, rgba(128,128,128,.3)); color: var(--vscode-badge-foreground, inherit); border-radius: 10px; padding: 0 7px; font-size: .95em; letter-spacing: 0; }
.ic { flex: none; vertical-align: -3px; }
.spin { animation: spin 1s linear infinite; transform-origin: 50% 50%; }
@keyframes spin { to { transform: rotate(360deg); } }
.t-success { color: var(--al-green); }
.t-failure { color: var(--al-red); }
.t-running, .t-queued, .t-attention { color: var(--al-yellow); }
.t-cancelled, .t-skipped, .t-neutral { color: var(--al-gray); }
.muted { color: var(--al-muted); }

.pill { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px 3px 7px; border-radius: 999px; font-weight: 600; font-size: .9em; white-space: nowrap; }
.pill.t-success { background: color-mix(in srgb, var(--al-green) 16%, transparent); }
.pill.t-failure { background: color-mix(in srgb, var(--al-red) 16%, transparent); }
.pill.t-running, .pill.t-queued, .pill.t-attention { background: color-mix(in srgb, var(--al-yellow) 16%, transparent); }
.pill.t-cancelled, .pill.t-skipped, .pill.t-neutral { background: color-mix(in srgb, var(--al-gray) 16%, transparent); }

.header { display: flex; flex-direction: column; gap: 10px; padding-bottom: 18px; border-bottom: 1px solid var(--al-border); }
.title-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.meta { display: flex; flex-wrap: wrap; gap: 6px 16px; color: var(--al-muted); }
.meta span { display: inline-flex; align-items: center; gap: 5px; }
.meta .mono { color: var(--al-fg); }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }

.btn { display: inline-flex; align-items: center; gap: 6px; border: 1px solid transparent; border-radius: 4px; padding: 5px 11px; font: inherit; cursor: pointer; line-height: 1.3; }
.btn.primary { background: var(--vscode-button-background, #238636); color: var(--vscode-button-foreground, #fff); }
.btn.primary:hover { background: var(--vscode-button-hoverBackground, #2ea043); }
.btn.secondary { background: var(--vscode-button-secondaryBackground, rgba(128,128,128,.18)); color: var(--vscode-button-secondaryForeground, inherit); }
.btn.secondary:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,.28)); }
.btn.ghost { background: transparent; color: var(--al-link); padding: 3px 6px; }
.btn.ghost:hover { background: var(--al-hover); }
.btn:focus-visible { outline: 1px solid var(--vscode-focusBorder, #58a6ff); outline-offset: 1px; }
.pro { font-size: .72em; font-weight: 700; letter-spacing: .05em; padding: 0 5px; border-radius: 3px; background: color-mix(in srgb, var(--al-yellow) 25%, transparent); color: var(--al-yellow); }

.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin-top: 18px; }
.card { background: var(--al-card); border: 1px solid var(--al-border); border-radius: var(--al-radius); padding: 12px 14px; }
.card .label { color: var(--al-muted); font-size: .85em; display: flex; align-items: center; gap: 6px; }
.card .value { font-size: 1.6em; font-weight: 600; margin-top: 2px; font-variant-numeric: tabular-nums; }
.card .sub { color: var(--al-muted); font-size: .88em; margin-top: 2px; }
.card .sub b { font-weight: 600; }

.banner { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-radius: var(--al-radius); margin-top: 16px; border: 1px solid; }
.banner.warn { border-color: color-mix(in srgb, var(--al-yellow) 45%, transparent); background: color-mix(in srgb, var(--al-yellow) 10%, transparent); }
.banner.info { border-color: color-mix(in srgb, var(--al-blue) 45%, transparent); background: color-mix(in srgb, var(--al-blue) 8%, transparent); }
.banner .grow { flex: 1; }

.failure { border: 1px solid var(--al-border); border-left: 3px solid var(--al-red); border-radius: var(--al-radius); background: var(--al-card); margin-bottom: 12px; overflow: hidden; }
.failure-head { display: flex; align-items: center; gap: 10px; padding: 10px 14px; flex-wrap: wrap; }
.failure-head .grow { flex: 1; min-width: 200px; }
.failure-head .step { color: var(--al-muted); }
.excerpt { margin: 0; padding: 8px 0; background: var(--al-code-bg); overflow-x: auto; font-family: var(--vscode-editor-font-family, ui-monospace, Consolas, monospace); font-size: var(--vscode-editor-font-size, 12px); line-height: 1.55; border-top: 1px solid var(--al-border); }
.excerpt .ln { display: flex; white-space: pre; padding: 0 14px 0 0; }
.excerpt .no { flex: none; width: 52px; text-align: right; padding-right: 14px; color: var(--al-muted); opacity: .6; user-select: none; }
.excerpt .err { background: color-mix(in srgb, var(--al-red) 16%, transparent); }
.excerpt .err .no { color: var(--al-red); opacity: 1; }
.annotations { list-style: none; margin: 0; padding: 6px 14px 10px; border-top: 1px solid var(--al-border); }
.annotations li { display: flex; gap: 8px; align-items: baseline; padding: 3px 0; }

.timeline { border: 1px solid var(--al-border); border-radius: var(--al-radius); background: var(--al-card); padding: 6px 0 10px; }
.tl-axis, .tl-row { display: grid; grid-template-columns: minmax(150px, 28%) 1fr 72px; align-items: center; column-gap: 12px; padding: 0 14px; }
.tl-axis { height: 26px; color: var(--al-muted); font-size: .8em; }
.tl-axis .track { position: relative; height: 100%; }
.tl-axis .tick { position: absolute; top: 5px; transform: translateX(-50%); white-space: nowrap; }
.tl-row { min-height: 32px; border-radius: 4px; }
.tl-row:hover { background: var(--al-hover); }
.tl-row.group { min-height: 24px; color: var(--al-muted); font-size: .85em; font-weight: 600; margin-top: 4px; }
.tl-row.group:hover { background: none; }
.tl-name { display: flex; align-items: center; gap: 8px; min-width: 0; cursor: pointer; }
.tl-name span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tl-row.child .tl-name { padding-left: 14px; }
.track { position: relative; height: 18px; }
.grid-line { position: absolute; top: -8px; bottom: -8px; width: 1px; background: var(--al-border); opacity: .6; }
.bar { position: absolute; top: 3px; height: 12px; border-radius: 3px; display: flex; overflow: hidden; min-width: 3px; }
.bar .seg { height: 100%; border-right: 1px solid var(--al-card); cursor: pointer; min-width: 2px; }
.bar .seg:last-child { border-right: none; }
.bar .seg:hover { filter: brightness(1.25); }
.seg.t-success { background: color-mix(in srgb, var(--al-green) 70%, transparent); }
.seg.t-failure { background: var(--al-red); }
.seg.t-running { background: repeating-linear-gradient(-45deg, var(--al-yellow) 0 6px, color-mix(in srgb, var(--al-yellow) 60%, transparent) 6px 12px); background-size: 17px 17px; animation: stripes .8s linear infinite; }
.seg.t-queued, .seg.t-neutral, .seg.t-attention { background: color-mix(in srgb, var(--al-gray) 35%, transparent); }
.seg.t-cancelled { background: color-mix(in srgb, var(--al-gray) 55%, transparent); }
.seg.t-skipped { background: transparent; }
@keyframes stripes { to { background-position: 17px 0; } }
.wait { position: absolute; top: 8px; height: 2px; background: repeating-linear-gradient(90deg, var(--al-gray) 0 3px, transparent 3px 6px); opacity: .6; }
.tl-time { text-align: right; color: var(--al-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.tl-note { position: absolute; top: 0; font-size: .85em; color: var(--al-muted); white-space: nowrap; }
.legend { display: flex; gap: 14px; padding: 8px 14px 0; color: var(--al-muted); font-size: .82em; flex-wrap: wrap; }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }

.list { border: 1px solid var(--al-border); border-radius: var(--al-radius); background: var(--al-card); overflow: hidden; }
.list .item { display: flex; align-items: center; gap: 10px; padding: 8px 14px; border-top: 1px solid var(--al-border); }
.list .item:first-child { border-top: none; }
.list .item:hover { background: var(--al-hover); }
.list .item .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

table { width: 100%; border-collapse: collapse; }
th { text-align: left; font-weight: 600; color: var(--al-muted); font-size: .85em; padding: 8px 14px; border-bottom: 1px solid var(--al-border); }
td { padding: 7px 14px; border-top: 1px solid var(--al-border); vertical-align: middle; }
tr:first-child td { border-top: none; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.meter { height: 6px; border-radius: 3px; background: var(--al-code-bg); overflow: hidden; min-width: 60px; }
.meter > div { height: 100%; border-radius: 3px; }

.chart { border: 1px solid var(--al-border); border-radius: var(--al-radius); background: var(--al-card); padding: 14px 14px 8px; }
.chart svg { display: block; width: 100%; height: 170px; overflow: visible; }
.chart .bar-hit { cursor: pointer; }
.chart .bar-hit:hover rect.b { filter: brightness(1.3); }
.chart-foot { display: flex; justify-content: space-between; color: var(--al-muted); font-size: .8em; margin-top: 4px; }

.empty { color: var(--al-muted); padding: 14px; text-align: center; }
.skeleton { height: 14px; border-radius: 4px; background: linear-gradient(90deg, var(--al-code-bg), var(--al-hover), var(--al-code-bg)); background-size: 200% 100%; animation: shimmer 1.2s infinite; }
@keyframes shimmer { to { background-position: -200% 0; } }
.split { display: grid; grid-template-columns: 1fr auto 1fr; gap: 12px; align-items: stretch; margin-top: 18px; }
.split .arrow { align-self: center; color: var(--al-muted); font-size: 1.4em; }
@media (max-width: 640px) {
  main { padding: 14px 12px 32px; }
  .tl-axis, .tl-row { grid-template-columns: 120px 1fr 56px; column-gap: 8px; padding: 0 8px; }
  .split { grid-template-columns: 1fr; }
  .split .arrow { display: none; }
}
@media (prefers-reduced-motion: reduce) { .spin, .seg.t-running, .skeleton { animation: none; } }
`;

/** Runs in the page: sends clicks on `data-cmd` elements to the extension and keeps live durations counting. */
export const SCRIPT = `
const vscode = acquireVsCodeApi();
const app = document.getElementById('app');
document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-cmd]');
  if (!target) return;
  event.preventDefault();
  vscode.postMessage({ ...target.dataset });
});
window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'render') {
    app.innerHTML = message.html;
    tick();
  }
});
function fmt(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + String(s % 60).padStart(2, '0') + 's';
  return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm';
}
function tick() {
  for (const el of document.querySelectorAll('[data-since]')) {
    el.textContent = fmt(Date.now() - Number(el.dataset.since));
  }
}
setInterval(tick, 1000);
`;

export interface PageOptions {
  title: string;
  body: string;
  cspSource: string;
  nonce: string;
}

export function page(options: PageOptions): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${options.cspSource} 'unsafe-inline'; img-src ${options.cspSource} data: https:; script-src 'nonce-${options.nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(options.title)}</title>
<style>${CSS}</style>
</head>
<body>
<main id="app">${options.body}</main>
<script nonce="${options.nonce}">${SCRIPT}</script>
</body>
</html>`;
}
