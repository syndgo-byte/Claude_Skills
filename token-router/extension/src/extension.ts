import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const CLAUDE_VIEW_TYPE = 'claudeVSCodePanel';
const SCAN_MAX_AGE = 7 * 24 * 3600 * 1000;

const STATE_FILE = path.join(os.homedir(), '.claude', 'token-router', 'state.json');

// The warning / forced-handoff limits handoff.js acts on.
function limits(): { threshold: number; loop: number } {
  let st: any = {};
  try { st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { }
  return { threshold: st.handoffTokens || 80000, loop: st.loopTokens || 200000 };
}

interface Transcript {
  size: number;
  mtime: number;
  leftover: string;
  aiTitle: string;
  customTitle: string;
  context: number;
  model: string;
}

interface TabStatus {
  label: string;
  active: boolean;
  matched: boolean;
  context: number;
  model: string;
  emoji: string;
  color: string;
  percent: number;
  loop: number;
  atLoop: boolean;
}

const transcripts = new Map<string, Transcript>();

// Reads only the bytes appended since the last call, so an open tab costs little per second.
function updateTranscript(file: string, stat: fs.Stats) {
  let t = transcripts.get(file);
  if (t && t.size === stat.size && t.mtime === stat.mtimeMs) return;
  if (!t || stat.size < t.size) {
    t = { size: 0, mtime: 0, leftover: '', aiTitle: '', customTitle: '', context: 0, model: '' };
    transcripts.set(file, t);
  }
  const len = stat.size - t.size;
  if (len > 0) {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, t.size);
      const lines = (t.leftover + buf.toString('utf8')).split('\n');
      t.leftover = lines.pop() || '';
      for (const line of lines) parseLine(t, line);
    } finally {
      fs.closeSync(fd);
    }
  }
  t.size = stat.size;
  t.mtime = stat.mtimeMs;
}

function parseLine(t: Transcript, line: string) {
  if (!line) return;
  let e: any;
  try { e = JSON.parse(line); } catch { return; }
  if (e.type === 'ai-title' && e.aiTitle) t.aiTitle = e.aiTitle;
  else if (e.type === 'custom-title' && e.customTitle) t.customTitle = e.customTitle;
  else if (e.subtype === 'compact_boundary') t.context = 0;
  else if (e.type === 'assistant' && e.message?.usage) {
    const u = e.message.usage;
    t.context = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    t.model = e.message.model || t.model;
  }
}

function scanTranscripts() {
  const now = Date.now();
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(PROJECTS_DIR); } catch { return; }
  for (const d of dirs) {
    const dir = path.join(PROJECTS_DIR, d);
    let files: string[] = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(dir, f);
      try {
        const stat = fs.statSync(full);
        if (now - stat.mtimeMs > SCAN_MAX_AGE && !transcripts.has(full)) continue;
        updateTranscript(full, stat);
      } catch { }
    }
  }
}

function openClaudeTabs(): { label: string; active: boolean }[] {
  const tabs: { label: string; active: boolean }[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (input instanceof vscode.TabInputWebview && input.viewType.endsWith(CLAUDE_VIEW_TYPE)) {
        tabs.push({ label: tab.label, active: tab.isActive && group.isActive });
      }
    }
  }
  return tabs;
}

function statusFor(tab: { label: string; active: boolean }, threshold: number, loop: number): TabStatus {
  // Claude Code cuts long titles to "…"/"...", so a cut label matches by prefix.
  // A title can repeat (forks, resumed sessions); the most recently written transcript wins.
  const label = tab.label.trim();
  const cut = label.replace(/(\.\.\.|…)$/, '').trim();
  const isCut = cut !== label;
  let best: Transcript | undefined;
  for (const t of transcripts.values()) {
    const title = (t.customTitle || t.aiTitle).trim();
    if (!title) continue;
    const hit = title === label || (isCut && title.startsWith(cut));
    if (hit && (!best || t.mtime > best.mtime)) best = t;
  }
  const context = best ? best.context : 0;
  const model = best ? best.model : '';
  const emoji = context >= loop ? '🔴' : context >= threshold ? '🟠' : context >= threshold * 0.875 ? '🟡' : '🟢';
  return {
    label: tab.label,
    active: tab.active,
    matched: !!best,
    context,
    model,
    emoji,
    color: COLORS[emoji],
    percent: Math.round((context / loop) * 100),
    loop,
    atLoop: context >= loop,
  };
}

const COLORS: { [emoji: string]: string } = {
  '🟢': '#22c55e',
  '🟡': '#eab308',
  '🟠': '#f97316',
  '🔴': '#ef4444',
};

const ICONS: { [emoji: string]: string } = {
  '🟢': '$(circle-filled)',
  '🟡': '$(warning)',
  '🟠': '$(circle-outline)',
  '🔴': '$(error)',
};

const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

let statusBar: vscode.StatusBarItem;
let sideBarButton: vscode.StatusBarItem;
let webviewProvider: TokenRouterWebviewProvider;

export function activate(context: vscode.ExtensionContext) {
  webviewProvider = new TokenRouterWebviewProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('token-router-panel', webviewProvider)
  );

  sideBarButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  sideBarButton.command = 'token-router.showPanel';
  context.subscriptions.push(sideBarButton);

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'token-router.showPanel';
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand('token-router.showPanel', () => {
      vscode.commands.executeCommand('token-router-container.focus');
    }),
    vscode.window.tabGroups.onDidChangeTabs(() => update()),
    vscode.window.tabGroups.onDidChangeTabGroups(() => update()),
  );

  update();
  const interval = setInterval(update, 1000);
  context.subscriptions.push({ dispose: () => clearInterval(interval) });
}

function update() {
  scanTranscripts();
  const { threshold, loop } = limits();
  const tabs = openClaudeTabs().map((t) => statusFor(t, threshold, loop));
  const current = tabs.find((t) => t.active) || tabs[0];

  if (current) {
    const icon = ICONS[current.emoji];
    const text = `${current.label}\n${fmt(current.context)} / ${fmt(current.loop)} (${current.percent}%)`;
    sideBarButton.text = icon;
    sideBarButton.tooltip = text;
    statusBar.text = `${icon} ${fmt(current.context)} (${current.percent}%)`;
    statusBar.tooltip = `${text}\nModel: ${current.model || '-'}`;
    statusBar.color = current.color;
  } else {
    sideBarButton.text = '$(circle-slash)';
    sideBarButton.tooltip = '열린 Claude 탭 없음';
    statusBar.text = '$(circle-slash) Claude 탭 없음';
    statusBar.tooltip = '';
    statusBar.color = undefined;
  }
  sideBarButton.show();
  statusBar.show();
  webviewProvider.post(tabs);
}

class TokenRouterWebviewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private last: TabStatus[] = [];

  public resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = HTML;
    webviewView.onDidChangeVisibility(() => this.post(this.last));
    this.post(this.last);
  }

  public post(tabs: TabStatus[]) {
    this.last = tabs;
    this.view?.webview.postMessage(tabs);
  }
}

const HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #e0e0e0; padding: 12px; }
  .card { background: #252526; border: 1px solid #3e3e42; border-radius: 8px; padding: 14px; margin-bottom: 10px; }
  .card.active { border-color: #4ec9b0; }
  .head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .title { font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .badge { font-size: 10px; color: #4ec9b0; border: 1px solid #4ec9b0; border-radius: 4px; padding: 1px 5px; }
  .ctx { font-size: 24px; font-weight: bold; }
  .range { font-size: 12px; color: #858585; margin-left: 4px; }
  .bar { height: 6px; background: #3e3e42; border-radius: 3px; margin-top: 8px; overflow: hidden; }
  .fill { height: 100%; }
  .meta { font-size: 11px; color: #858585; margin-top: 6px; }
  .handoff { margin-top: 10px; padding: 8px; background: #d32f2f; border-radius: 6px; text-align: center; font-size: 12px; font-weight: 600; color: white; }
  .empty { color: #666; font-size: 13px; text-align: center; padding: 24px 0; }
</style>
</head>
<body>
<div id="root"><div class="empty">열린 Claude 탭 없음</div></div>
<script>
  const root = document.getElementById('root');
  const fmt = (n) => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  window.addEventListener('message', (ev) => {
    const tabs = ev.data || [];
    root.replaceChildren();
    if (!tabs.length) { root.append(el('div', 'empty', '열린 Claude 탭 없음')); return; }
    for (const t of tabs) {
      const card = el('div', 'card' + (t.active ? ' active' : ''));
      const head = el('div', 'head');
      head.append(el('span', '', t.emoji), el('span', 'title', t.label));
      if (t.active) head.append(el('span', 'badge', '현재'));
      const ctx = el('div');
      const num = el('span', 'ctx', t.matched ? fmt(t.context) : '0');
      num.style.color = t.color;
      ctx.append(num, el('span', 'range', '/ ' + fmt(t.loop)));
      const bar = el('div', 'bar');
      const fill = el('div', 'fill');
      fill.style.width = Math.min(t.percent, 100) + '%';
      fill.style.background = t.color;
      bar.append(fill);
      const meta = el('div', 'meta', t.matched ? t.percent + '% · ' + (t.model || '-') : '대화 기록 대기 중');
      card.append(head, ctx, bar, meta);
      if (t.atLoop) card.append(el('div', 'handoff', '🔴 handoff 됩니다 · 압축 후 0으로 리셋'));
      root.append(card);
    }
  });
</script>
</body>
</html>`;

export function deactivate() { }
