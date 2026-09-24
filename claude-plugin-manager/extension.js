'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const store = require('./lib/store');
const cli = require('./lib/cli');
const rec = require('./lib/recommend');
const i18n = require('./lib/i18n');
const dupes = require('./lib/dupes');
const updates = require('./lib/updates');
const freeView = require('./freeView');
const usage = require('./lib/usage');

const CACHE_KEY = 'cpm.githubCache';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

let output;

function config() {
  return vscode.workspace.getConfiguration('claudePluginManager');
}

function claudePath() {
  return cli.findClaude(config().get('claudePath'));
}

function md(text) {
  const s = new vscode.MarkdownString(text);
  s.supportThemeIcons = true;
  return s;
}

function oneLine(text, max = 90) {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function korean() {
  return config().get('koreanDescriptions') !== false;
}

// Korean text when available, otherwise the original description.
function localized(key, original) {
  return (korean() && i18n.lookup(key)) || original || '';
}

// Tooltip body: Korean first, then the original text for reference.
function descriptionBlock(key, original) {
  const ko = korean() && i18n.lookup(key);
  if (!ko) return original || '_설명 없음_';
  return original ? `${ko}\n\n---\n\n_원문: ${original}_` : ko;
}

function componentSummary(c) {
  const parts = [];
  if (c.skills.length) parts.push(`스킬 ${c.skills.length}`);
  if (c.commands.length) parts.push(`명령 ${c.commands.length}`);
  if (c.agents.length) parts.push(`에이전트 ${c.agents.length}`);
  if (c.hooks.length) parts.push(`훅 ${c.hooks.length}`);
  if (c.mcpServers.length) parts.push(`MCP ${c.mcpServers.length}`);
  if (c.lspServers.length) parts.push(`LSP ${c.lspServers.length}`);
  return parts.join(' · ');
}

// ---------- Installed plugins tree ----------

class InstalledProvider {
  constructor() {
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
    this.plugins = [];
    this.load();
  }

  personalItem(s) {
    const it = new vscode.TreeItem(s.name, vscode.TreeItemCollapsibleState.None);
    it.personal = s;
    it.id = s.id;
    const key = `personal:${s.name}`;
    const use = this.usage && this.usage.stats[s.id];
    const tags = [];
    if (!s.enabled) tags.push('(꺼짐)');
    if (use && use.count) tags.push(`${this.usage.days}일 ${use.count}회`);
    it.description = `${tags.length ? `${tags.join(' ')} · ` : ''}${oneLine(localized(key, s.description), 60)}`;
    it.checkboxState = s.enabled ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
    it.iconPath = new vscode.ThemeIcon(s.enabled ? 'lightbulb' : 'circle-slash');
    it.contextValue = 'personal';
    it.tooltip = md([
      `**${s.name}** — 개인 스킬 ${s.enabled ? '$(check) 켜짐' : '$(circle-slash) 꺼짐'}`,
      '',
      descriptionBlock(key, s.description),
      '',
      `- 위치: \`${s.root}\``,
      s.scripts.length ? `- 스크립트: ${s.scripts.join(', ')}` : '',
      use ? `- 최근 ${this.usage.days}일 사용 ${use.count}회` : '',
    ].join('\n'));
    it.command = { command: 'vscode.open', title: '열기', arguments: [vscode.Uri.file(s.file)] };
    return it;
  }

  load() {
    this.personal = store.listPersonalSkills();
    this.plugins = store.listInstalled();
    this.dupes = dupes.analyze(this.plugins);
    // Drop update marks that no longer apply (plugin removed or already updated to that commit).
    const ups = this.updates || {};
    this.updates = {};
    for (const p of this.plugins) {
      const u = ups[p.id];
      if (u && !(p.gitCommitSha && u.head.startsWith(p.gitCommitSha))) this.updates[p.id] = u;
    }
  }

  setUsage(result) {
    this.usage = result;
    this._emitter.fire();
  }

  // Enabled, measurable plugins with no use in the window, installed long enough to judge.
  unused() {
    if (!this.usage) return [];
    const grace = (config().get('unusedGraceDays') || 14) * 86400000;
    return this.plugins.filter((p) => p.enabled && !usage.isAutomatic(p)
      && (!p.installedAt || Date.now() - Date.parse(p.installedAt) >= grace)
      && this.usage.stats[p.id] && this.usage.stats[p.id].count === 0);
  }

  setUpdates(updates) {
    this.updates = updates || {};
    this.load();
    this._emitter.fire();
  }

  refresh() {
    this.load();
    this._emitter.fire();
  }

  getTreeItem(el) {
    return el;
  }

  getChildren(el) {
    if (!el) {
      const top = [];
      const upCount = Object.keys(this.updates).length;
      if (upCount) {
        const it = new vscode.TreeItem(`업데이트 ${upCount}개 있음 — 클릭해서 모두 업데이트`);
        it.iconPath = new vscode.ThemeIcon('arrow-circle-up', new vscode.ThemeColor('charts.green'));
        it.command = { command: 'cpm.updateAll', title: '모두 업데이트' };
        top.push(it);
      }
      const idle = this.unused();
      if (idle.length) {
        const it = new vscode.TreeItem(`${this.usage.days}일간 안 쓴 플러그인 ${idle.length}개 — 클릭해서 정리`);
        it.description = idle.map((p) => p.name).join(', ');
        it.tooltip = 'Claude Code 대화 기록을 분석한 결과, 이 기간 동안 스킬·명령·에이전트·MCP 호출이 한 번도 없었습니다. 켜 두면 매 세션 스킬 목록이 컨텍스트를 차지합니다.';
        it.iconPath = new vscode.ThemeIcon('trash', new vscode.ThemeColor('charts.orange'));
        it.command = { command: 'cpm.usage.cleanup', title: '안 쓰는 플러그인 정리' };
        top.push(it);
      }
      if (this.dupes.redundant.length) {
        const names = this.dupes.redundant.map((id) => id.split('@')[0]).join(', ');
        const it = new vscode.TreeItem(`중복 플러그인 ${this.dupes.redundant.length}개 — 클릭해서 정리`);
        it.description = names;
        it.tooltip = '같은 플러그인이 여러 마켓플레이스에서 두 번 이상 설치돼 켜져 있습니다. 하나만 남기고 끄세요.';
        it.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
        it.command = { command: 'cpm.dedupe', title: '중복 정리' };
        top.push(it);
      }
      const personal = new vscode.TreeItem(`개인 스킬 (${this.personal.length})`, vscode.TreeItemCollapsibleState.Expanded);
      personal.iconPath = new vscode.ThemeIcon('person');
      personal.description = '~/.claude/skills';
      personal.tooltip = '마켓플레이스가 아닌 ~/.claude/skills 폴더에 직접 둔 스킬입니다. 끄면 ~/.claude/skills-disabled 로 옮겨집니다.';
      personal.group = true;
      personal.children = this.personal.map((s) => this.personalItem(s));
      return [...top, ...this.plugins.map((p) => this.pluginItem(p)), personal];
    }
    if (el.plugin && !el.group) return this.groupItems(el.plugin);
    if (el.group) return el.children;
    return [];
  }

  pluginItem(p) {
    const c = p.components;
    const hasChildren = c.skills.length + c.commands.length + c.agents.length + c.hooks.length
      + c.mcpServers.length + c.lspServers.length > 0;
    const item = new vscode.TreeItem(p.name,
      hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.plugin = p;
    item.id = p.id;
    const pKey = i18n.pluginKey(p);
    const up = this.updates[p.id];
    const redundant = this.dupes.redundant.includes(p.id);
    const tags = [];
    if (up) tags.push('⬆ 업데이트');
    if (redundant) tags.push('⚠ 중복');
    if (!p.enabled) tags.push('(꺼짐)');
    const use = this.usage && this.usage.stats[p.id];
    if (use && !usage.isAutomatic(p)) {
      if (use.count) tags.push(`${this.usage.days}일 ${use.count}회`);
      else if (this.unused().includes(p)) tags.push(`🗑 ${this.usage.days}일 미사용`);
    }
    item.description = `${tags.length ? `${tags.join(' ')} · ` : ''}${oneLine(localized(pKey, p.description), 60)}`;
    item.checkboxState = p.enabled ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
    item.contextValue = `plugin${p.homepage ? '.web' : ''}${up ? '.upd' : ''}`;
    item.iconPath = up ? new vscode.ThemeIcon('arrow-circle-up', new vscode.ThemeColor('charts.green'))
      : redundant ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'))
        : new vscode.ThemeIcon(p.enabled ? 'extensions' : 'circle-slash');
    const dupLines = [];
    for (const [key, others] of this.dupes.byItem) {
      if (key.startsWith(`${p.id}/`)) dupLines.push(`- \`${key.split('/').pop()}\` ↔ ${others.join(', ')}`);
    }
    item.tooltip = md([
      `**${p.name}** \`v${p.version}\` — ${p.enabled ? '$(check) 켜짐' : '$(circle-slash) 꺼짐'}`,
      '',
      descriptionBlock(pKey, p.description),
      '',
      `- 마켓플레이스: \`${p.marketplace}\``,
      p.author ? `- 만든 사람: ${p.author}` : '',
      `- 구성: ${componentSummary(c) || '없음'}`,
      p.homepage ? `- ${p.homepage}` : '',
      ...(use ? ['', usage.isAutomatic(p) ? '$(pulse) 훅·LSP로 자동 실행되는 플러그인이라 사용 횟수를 셀 수 없습니다.'
        : `$(pulse) **최근 ${this.usage.days}일 사용 ${use.count}회**${use.last ? ` · 마지막 ${new Date(use.last).toLocaleDateString()}` : ''}`,
      ...Object.entries(use.items).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `- \`${k}\` ${v}회`)] : []),
      ...(up ? ['', `**$(arrow-circle-up) 업데이트 있음** — 새 커밋 ${up.behind}개`
        + `${up.date ? `, 최근 ${new Date(up.date).toLocaleDateString()}` : ''}`,
      ...up.messages.map((m) => `- ${m}`)] : []),
      ...(dupLines.length ? ['', `**$(warning) 겹치는 항목${redundant ? ' (전부 겹침 — 꺼도 됨)' : ''}**`, ...dupLines] : []),
    ].join('\n'));
    return item;
  }

  groupItems(p) {
    const c = p.components;
    const groups = [];
    const group = (label, icon, children) => {
      if (!children.length) return;
      const g = new vscode.TreeItem(`${label} (${children.length})`, vscode.TreeItemCollapsibleState.Collapsed);
      g.group = true;
      g.plugin = p;
      g.id = `${p.id}/${label}`;
      g.iconPath = new vscode.ThemeIcon(icon);
      g.children = children;
      groups.push(g);
    };
    const docItem = (x, icon, prefix, kind) => {
      const key = i18n.compKey(p, kind, x.name);
      const dupWith = this.dupes.byItem.get(`${p.id}/${kind}/${x.name}`);
      const it = new vscode.TreeItem(`${prefix}${x.name}`, vscode.TreeItemCollapsibleState.None);
      it.description = `${dupWith ? `[중복: ${dupWith.join(', ')}] ` : ''}${oneLine(localized(key, x.description), 80)}`;
      it.tooltip = md(`**${prefix}${x.name}**${dupWith ? `\n\n$(warning) 같은 기능이 ${dupWith.join(', ')}에도 있습니다.` : ''}`
        + `\n\n${descriptionBlock(key, x.description)}`);
      it.iconPath = dupWith ? new vscode.ThemeIcon('copy', new vscode.ThemeColor('charts.yellow')) : new vscode.ThemeIcon(icon);
      it.command = { command: 'vscode.open', title: '열기', arguments: [vscode.Uri.file(x.file)] };
      return it;
    };
    const plain = (name, icon, tip) => {
      const it = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.None);
      it.iconPath = new vscode.ThemeIcon(icon);
      it.tooltip = tip;
      return it;
    };
    group('스킬', 'lightbulb', c.skills.map((s) => docItem(s, 'lightbulb', '', 'skills')));
    group('명령', 'terminal', c.commands.map((s) => docItem(s, 'terminal', '/', 'commands')));
    group('에이전트', 'person', c.agents.map((s) => docItem(s, 'person', '', 'agents')));
    group('훅', 'zap', c.hooks.map((h) => {
      const it = plain(h, 'zap', `${i18n.hookEvent(h) || h} 자동으로 실행되는 스크립트`);
      it.description = i18n.hookEvent(h) ? `${i18n.hookEvent(h)} 자동 실행` : '';
      return it;
    }));
    group('MCP 서버', 'plug', c.mcpServers.map((h) => {
      const it = plain(h, 'plug', '외부 도구를 Claude에 연결하는 MCP 서버');
      it.description = '외부 도구 연결';
      return it;
    }));
    group('LSP 서버', 'symbol-class', c.lspServers.map((h) => {
      const it = plain(h, 'symbol-class', '타입 검사와 코드 탐색을 제공하는 언어 서버');
      it.description = '타입 검사·코드 탐색';
      return it;
    }));
    return groups;
  }
}

// ---------- Recommendation tree ----------

class RecommendProvider {
  constructor(context, installed) {
    this.context = context;
    this.installed = installed;
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
    this.market = [];
    this.github = [];
    this.errors = [];
    this.loading = false;
    this.fetchedAt = undefined;
    const cached = context.globalState.get(CACHE_KEY);
    if (cached) {
      this.github = cached.list;
      this.fetchedAt = cached.at;
    }
  }

  async refresh(force) {
    if (this.loading) return;
    this.loading = true;
    this._emitter.fire();
    try {
      const profile = await workspaceProfile();
      const installedIds = new Set(this.installed.plugins.map((p) => p.id));
      this.market = rec.fromMarketplaces(store.listMarketplaces(), installedIds, profile).slice(0, 25);

      const cached = this.context.globalState.get(CACHE_KEY);
      if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
        this.github = cached.list;
        this.fetchedAt = cached.at;
        this.errors = [];
      } else {
        const known = knownRepos();
        const { list, errors } = await vscode.window.withProgress(
          { location: { viewId: 'cpm.recommend' }, title: 'GitHub에서 인기 스킬 수집 중' },
          () => rec.fromGitHub(config().get('githubToken'), profile, known));
        this.errors = errors;
        if (list.length) {
          this.github = list;
          this.fetchedAt = Date.now();
          await this.context.globalState.update(CACHE_KEY, { at: this.fetchedAt, list });
        }
      }
    } catch (e) {
      this.errors = [e.message];
    } finally {
      this.loading = false;
      this._emitter.fire();
    }
    if (this.afterLoad) this.afterLoad();
  }

  redraw() {
    this._emitter.fire();
  }

  // Recommendations minus anything already installed or already added as a marketplace.
  visible() {
    const plugins = this.installed.plugins;
    const ids = new Set(plugins.map((p) => p.id));
    const names = new Set(plugins.map((p) => p.name));
    const repos = hiddenRepos(plugins);
    // Also hide repos named after an installed plugin or marketplace (forks, mirrors, renamed repos).
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const installedNames = new Set([...plugins.map((p) => norm(p.name)), ...plugins.map((p) => norm(p.marketplace))]);
    return {
      market: this.market.filter((m) => !ids.has(m.id) && !names.has(m.name)),
      github: this.github.filter((g) => !repos.has(g.repo.toLowerCase()) && !installedNames.has(norm(g.name))),
    };
  }

  // Descriptions on screen that still need Korean text.
  missingText() {
    const out = {};
    const { market, github } = this.visible();
    for (const m of market) if (m.description && !i18n.lookup(`plugin:${m.name}`)) out[`plugin:${m.name}`] = m.description;
    for (const g of github) if (g.description && !i18n.lookup(`rec:${g.repo}`)) out[`rec:${g.repo}`] = g.description;
    return out;
  }

  getTreeItem(el) {
    return el;
  }

  getChildren(el) {
    if (el && el.children) return el.children;
    if (el) return [];
    if (this.loading && !this.github.length && !this.market.length) {
      const it = new vscode.TreeItem('불러오는 중…');
      it.iconPath = new vscode.ThemeIcon('loading~spin');
      return [it];
    }
    const { market, github } = this.visible();
    const hot = github.filter((g) => !g.rising);
    const rising = github.filter((g) => g.rising);
    const sections = [];
    const section = (label, icon, children, desc) => {
      const s = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
      s.iconPath = new vscode.ThemeIcon(icon);
      s.description = desc;
      s.children = children.length ? children : [emptyItem()];
      sections.push(s);
    };
    section('내 프로젝트에 맞는 플러그인', 'target', market.map((m) => this.marketItem(m)),
      '미설치 · 등록된 마켓플레이스 기준');
    section('GitHub 인기 (최근 90일 활동)', 'flame', hot.map((g) => this.githubItem(g)),
      this.fetchedAt ? `미설치 · ${new Date(this.fetchedAt).toLocaleString()} 기준` : '');
    section('GitHub 급상승 (최근 60일 신규)', 'rocket', rising.map((g) => this.githubItem(g)), '미설치');
    for (const err of this.errors) {
      const it = new vscode.TreeItem(err);
      it.iconPath = new vscode.ThemeIcon('warning');
      sections.push(it);
    }
    return sections;
  }

  marketItem(m) {
    const it = new vscode.TreeItem(m.name);
    it.rec = m;
    const mKey = `plugin:${m.name}`;
    it.description = `${m.marketplace} · ${oneLine(localized(mKey, m.description), 60)}`;
    it.iconPath = new vscode.ThemeIcon(m.marketplace === 'claude-plugins-official' ? 'verified' : 'package');
    it.contextValue = 'rec.market';
    it.tooltip = md([
      `**${m.name}** @ \`${m.marketplace}\``,
      '',
      descriptionBlock(mKey, m.description),
      '',
      m.matched.length ? `추천 이유: 프로젝트 키워드 ${m.matched.map((w) => `\`${w}\``).join(', ')}` : '',
      '',
      '$(cloud-download) 오른쪽 설치 버튼으로 바로 설치',
    ].join('\n'));
    return it;
  }

  githubItem(g) {
    const it = new vscode.TreeItem(g.repo);
    it.rec = g;
    const gKey = `rec:${g.repo}`;
    it.description = `★${formatStars(g.stars)} · ${oneLine(localized(gKey, g.description), 60)}`;
    it.iconPath = new vscode.ThemeIcon(g.installable ? 'cloud-download' : 'link-external');
    it.contextValue = g.installable ? 'rec.github.installable' : 'rec.github';
    it.tooltip = md([
      `**${g.repo}** ★ ${g.stars.toLocaleString()}`,
      '',
      descriptionBlock(gKey, g.description),
      '',
      `- 생성 ${g.ageDays}일 전 · 마지막 커밋 ${g.pushedDays}일 전 · 하루 평균 ★${g.velocity.toFixed(1)}`,
      g.topics.length ? `- 토픽: ${g.topics.slice(0, 8).join(', ')}` : '',
      g.matched.length ? `- 프로젝트 키워드 일치: ${g.matched.join(', ')}` : '',
      g.installable ? '- $(cloud-download) 플러그인 마켓플레이스 형식 — 바로 설치 가능'
        : '- $(info) 마켓플레이스 형식이 아님 — GitHub에서 설치 방법 확인',
    ].filter(Boolean).join('\n'));
    it.command = { command: 'cpm.rec.open', title: 'GitHub 열기', arguments: [it] };
    return it;
  }
}

function emptyItem() {
  const it = new vscode.TreeItem('항목 없음');
  it.iconPath = new vscode.ThemeIcon('dash');
  return it;
}

function formatStars(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

function knownRepos() {
  const s = store.readJson(store.SETTINGS_FILE, {});
  const set = new Set();
  for (const v of Object.values(s.extraKnownMarketplaces || {})) {
    if (v && v.source && v.source.repo) set.add(v.source.repo.toLowerCase());
  }
  return set;
}

// GitHub repos already on this PC: added marketplaces plus installed plugins' own repos.
function hiddenRepos(plugins) {
  const set = knownRepos();
  for (const p of plugins) {
    const m = (p.homepage || '').match(/github\.com\/([^/\s]+\/[^/\s#?]+)/i);
    if (m) set.add(m[1].replace(/\.git$/, '').toLowerCase());
  }
  return set;
}

async function workspaceProfile() {
  const files = await vscode.workspace.findFiles('**/*',
    '{**/node_modules/**,**/.git/**,**/.venv/**,**/venv/**,**/dist/**,**/build/**,**/__pycache__/**}', 5000);
  return rec.buildProfile(files.map((f) => f.fsPath));
}

// ---------- Actions ----------

async function applyToggles(changes, installed, status) {
  if (!Object.keys(changes).length) return;
  store.setEnabled(changes);
  installed.refresh();
  status.refresh();
  const names = Object.entries(changes).map(([id, on]) => `${id.split('@')[0]} ${on ? '켬' : '끔'}`).join(', ');
  vscode.window.showInformationMessage(`${names} — 새 Claude 세션부터 적용됩니다.`);
}

async function cliAction(title, args, installed, recommend) {
  output.show(true);
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, () =>
      cli.run(claudePath(), args, output));
    installed.refresh();
    if (recommend) recommend.refresh(false);
    return true;
  } catch (e) {
    vscode.window.showErrorMessage(`${title} 실패: ${e.message}`);
    return false;
  }
}

// Fills in missing Korean descriptions in the background with free web translators (no Claude tokens).
async function autoTranslate(installed, recommend, manual) {
  if (!korean()) return;
  const entries = { ...i18n.missing(installed.plugins), ...(recommend ? recommend.missingText() : {}) };
  for (const s of installed.personal) {
    if (s.description && !i18n.lookup(`personal:${s.name}`)) entries[`personal:${s.name}`] = s.description;
  }
  const count = Object.keys(entries).length;
  if (!count) {
    if (manual) vscode.window.showInformationMessage('모든 설명이 이미 한글로 준비돼 있습니다.');
    return;
  }
  const done = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `$(globe) 한글 설명 번역 중 (${count}개)` },
    () => i18n.translate(entries));
  installed.refresh();
  if (recommend) recommend.redraw();
  if (manual) vscode.window.showInformationMessage(`한글 설명 ${done}개를 번역했습니다.`);
}

async function installFromGithub(g, installed, recommend) {
  const ok = await cliAction(`${g.repo} 마켓플레이스 등록`, ['plugin', 'marketplace', 'add', g.repo], installed);
  if (!ok) return;
  const markets = store.listMarketplaces();
  const repoTail = g.repo.split('/')[1].toLowerCase();
  const market = markets.find((m) => m.name.toLowerCase() === repoTail)
    || markets.find((m) => path.basename(m.dir).toLowerCase() === repoTail)
    || await pickMarket(markets);
  if (!market) return;
  const installedIds = new Set(installed.plugins.map((p) => p.id));
  const picks = market.plugins
    .filter((p) => !installedIds.has(`${p.name}@${market.name}`))
    .map((p) => ({ label: p.name, description: oneLine(p.description, 100), picked: market.plugins.length === 1 }));
  if (!picks.length) {
    vscode.window.showInformationMessage(`${market.name}: 새로 설치할 플러그인이 없습니다.`);
    return;
  }
  const chosen = await vscode.window.showQuickPick(picks,
    { canPickMany: true, title: `${market.name}에서 설치할 플러그인 선택` });
  for (const p of chosen || []) {
    await cliAction(`${p.label} 설치`, ['plugin', 'install', `${p.label}@${market.name}`, '--scope', 'user'], installed);
  }
  recommend.refresh(false);
}

async function pickMarket(markets) {
  const pick = await vscode.window.showQuickPick(markets.map((m) => ({ label: m.name, market: m })),
    { title: '방금 등록한 마켓플레이스를 선택하세요' });
  return pick && pick.market;
}

// ---------- Status bar ----------

function createStatus(installed) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  item.command = 'cpm.quickToggle';
  // Do not name this `update`: StatusBarItem uses an internal update() and overriding it recurses.
  const refresh = () => {
    const all = installed.plugins;
    const on = all.filter((p) => p.enabled);
    const ups = Object.keys(installed.updates || {}).length;
    item.text = `$(extensions) Claude ${on.length}/${all.length}${ups ? ` $(arrow-circle-up)${ups}` : ''}`;
    item.tooltip = md([
      '**Claude 플러그인** — 클릭해서 켜기/끄기',
      ups ? `$(arrow-circle-up) 업데이트 ${ups}개 있음` : '',
      ...all.map((p) => `${p.enabled ? '$(check)' : '$(circle-slash)'}${installed.updates[p.id] ? ' $(arrow-circle-up)' : ''}`
        + ` **${p.name}** — ${oneLine(localized(i18n.pluginKey(p), p.description), 70)}`),
    ].join('\n\n'));
    if (config().get('showStatusBar')) item.show(); else item.hide();
  };
  refresh();
  return { refresh, dispose: () => item.dispose() };
}

// ---------- Activation ----------

function activate(context) {
  output = vscode.window.createOutputChannel('Claude Plugin Manager');
  const installed = new InstalledProvider();
  const recommend = new RecommendProvider(context, installed);
  recommend.afterLoad = () => autoTranslate(installed, recommend);
  const status = createStatus(installed);

  const installedView = vscode.window.createTreeView('cpm.installed',
    { treeDataProvider: installed, showCollapseAll: true, manageCheckboxStateManually: true });
  const recommendView = vscode.window.createTreeView('cpm.recommend', { treeDataProvider: recommend });

  installedView.onDidChangeCheckboxState((e) => {
    const changes = {};
    const skillNames = [];
    for (const [item, state] of e.items) {
      const on = state === vscode.TreeItemCheckboxState.Checked;
      if (item.plugin && !item.group) changes[item.plugin.id] = on;
      if (item.personal && item.personal.enabled !== on) {
        try {
          store.setPersonalSkillEnabled(item.personal, on);
          skillNames.push(`${item.personal.name} ${on ? '켬' : '끔'}`);
        } catch (err) {
          vscode.window.showErrorMessage(`${item.personal.name}: ${err.message}`);
        }
      }
    }
    if (skillNames.length) {
      installed.refresh();
      vscode.window.showInformationMessage(`${skillNames.join(', ')} — 새 Claude 세션부터 적용됩니다.`);
    }
    applyToggles(changes, installed, status);
  });

  let recommendLoaded = false;
  recommendView.onDidChangeVisibility((e) => {
    if (e.visible && !recommendLoaded) {
      recommendLoaded = true;
      recommend.refresh(false);
    }
  });

  // Reload when the CLI or another window changes plugin state.
  let timer;
  const reload = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      i18n.load();
      installed.refresh();
      status.refresh();
      recommend.redraw();
      autoTranslate(installed, recommend);
    }, 400);
  };
  const watchers = [];
  if (!fs.existsSync(i18n.USER_FILE)) fs.writeFileSync(i18n.USER_FILE, '{}\n', 'utf8');
  for (const file of [store.SETTINGS_FILE, store.INSTALLED_FILE, i18n.USER_FILE]) {
    try { watchers.push(fs.watch(file, reload)); } catch { /* file may not exist yet */ }
  }

  autoTranslate(installed, null);

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  freeView.register(context, (entries) => (korean() && Object.keys(entries).length
    ? i18n.translate(entries) : Promise.resolve(0)));

  // Update check: cached result on startup, a fresh check when older than 6 hours, then every 6 hours.
  const UPDATE_KEY = 'cpm.updates';
  const cachedUpdates = context.globalState.get(UPDATE_KEY);
  if (cachedUpdates) installed.setUpdates(cachedUpdates.updates);
  status.refresh();
  let checking = false;
  const checkUpdates = async (manual) => {
    if (checking) return;
    checking = true;
    try {
      const before = new Set(Object.keys(installed.updates));
      const r = await vscode.window.withProgress(
        { location: manual ? vscode.ProgressLocation.Notification : vscode.ProgressLocation.Window,
          title: '$(sync~spin) 플러그인 업데이트 확인 중' },
        () => updates.check(installed.plugins, cli.buildEnv(), config().get('githubToken')));
      await context.globalState.update(UPDATE_KEY, r);
      installed.setUpdates(r.updates);
      status.refresh();
      const ids = Object.keys(installed.updates);
      const fresh = ids.filter((id) => !before.has(id));
      if (manual || fresh.length) {
        const msg = ids.length ? `플러그인 업데이트 ${ids.length}개: ${ids.map((id) => id.split('@')[0]).join(', ')}`
          : '모든 플러그인이 최신입니다.';
        const extra = r.errors.length ? ` (확인 실패: ${r.errors.join('; ')})` : '';
        const pick = await vscode.window.showInformationMessage(msg + extra, ...(ids.length ? ['모두 업데이트'] : []));
        if (pick === '모두 업데이트') vscode.commands.executeCommand('cpm.updateAll');
      }
    } finally {
      checking = false;
    }
  };
  if (!cachedUpdates || Date.now() - cachedUpdates.checkedAt > CACHE_TTL_MS) setTimeout(() => checkUpdates(false), 5000);
  const updateTimer = setInterval(() => checkUpdates(false), CACHE_TTL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(updateTimer) });

  // Usage: count plugin use in local transcripts daily; suggest cleanup at most once a week.
  const USAGE_KEY = 'cpm.usage';
  const NOTIFY_KEY = 'cpm.usage.notifiedAt';
  const cachedUsage = context.globalState.get(USAGE_KEY);
  if (cachedUsage) installed.setUsage(cachedUsage);
  const runUsage = async (manual) => {
    const days = config().get('unusedDays') || 30;
    const r = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: '$(pulse) 플러그인 사용량 분석 중' },
      // Personal skills are counted too, as one-skill pseudo plugins keyed by their tree id.
      () => usage.analyze([...installed.plugins, ...installed.personal.map((s) => ({
        id: s.id, name: s.name,
        components: { skills: [{ name: s.name }], commands: [], agents: [], hooks: [], mcpServers: [], lspServers: [] },
      }))], days));
    await context.globalState.update(USAGE_KEY, r);
    installed.setUsage(r);
    const idle = installed.unused();
    const last = context.globalState.get(NOTIFY_KEY) || 0;
    if (!manual && (!idle.length || Date.now() - last < 7 * 86400000)) return;
    if (!idle.length) {
      vscode.window.showInformationMessage(`최근 ${days}일 동안 모든 플러그인을 사용했거나, 설치한 지 얼마 안 됐습니다. (대화 ${r.sessions}개 분석)`);
      return;
    }
    await context.globalState.update(NOTIFY_KEY, Date.now());
    const pick = await vscode.window.showInformationMessage(
      `최근 ${days}일 동안 안 쓴 Claude 플러그인 ${idle.length}개: ${idle.map((p) => p.name).join(', ')}. 정리할까요?`,
      '정리하기', '나중에');
    if (pick === '정리하기') vscode.commands.executeCommand('cpm.usage.cleanup');
  };
  const usageLast = cachedUsage ? cachedUsage.analyzedAt : 0;
  if (Date.now() - usageLast > 86400000) setTimeout(() => runUsage(false), 15000);
  else setTimeout(() => runUsage(false).catch(() => {}), 60000);
  const usageTimer = setInterval(() => runUsage(false), 24 * 3600000);
  context.subscriptions.push({ dispose: () => clearInterval(usageTimer) });

  reg('cpm.usage.analyze', () => runUsage(true));

  reg('cpm.usage.cleanup', async () => {
    const idle = installed.unused();
    if (!idle.length) {
      vscode.window.showInformationMessage('정리할 플러그인이 없습니다.');
      return;
    }
    const chosen = await vscode.window.showQuickPick(idle.map((p) => ({
      label: p.name, description: p.marketplace, picked: true, id: p.id, plugin: p,
      detail: `${oneLine(localized(i18n.pluginKey(p), p.description), 100)} · 설치 ${p.installedAt ? p.installedAt.slice(0, 10) : '?'}`,
    })), { canPickMany: true, title: `최근 ${installed.usage.days}일 동안 안 쓴 플러그인` });
    if (!chosen || !chosen.length) return;
    const action = await vscode.window.showQuickPick([
      { label: '끄기', description: '설치는 유지. 나중에 체크박스로 다시 켤 수 있음', value: 'off' },
      { label: '제거', description: '파일까지 삭제. 다시 쓰려면 재설치 필요', value: 'remove' },
    ], { title: `${chosen.length}개를 어떻게 할까요?` });
    if (!action) return;
    if (action.value === 'off') {
      applyToggles(Object.fromEntries(chosen.map((c) => [c.id, false])), installed, status);
    } else {
      for (const c of chosen) await cliAction(`${c.label} 제거`, ['plugin', 'uninstall', c.id], installed);
      status.refresh();
    }
  });


  reg('cpm.refresh', () => { installed.refresh(); status.refresh(); });

  reg('cpm.quickToggle', async () => {
    installed.refresh();
    const items = installed.plugins.map((p) => ({
      label: p.name, description: p.marketplace, detail: oneLine(localized(i18n.pluginKey(p), p.description), 140), picked: p.enabled, id: p.id,
    }));
    const chosen = await vscode.window.showQuickPick(items,
      { canPickMany: true, title: '켤 Claude 플러그인 선택 (체크 해제 = 끔)', matchOnDetail: true });
    if (!chosen) return;
    const on = new Set(chosen.map((c) => c.id));
    const changes = {};
    for (const p of installed.plugins) if (p.enabled !== on.has(p.id)) changes[p.id] = on.has(p.id);
    applyToggles(changes, installed, status);
  });

  reg('cpm.enableAll', () => applyToggles(
    Object.fromEntries(installed.plugins.filter((p) => !p.enabled).map((p) => [p.id, true])), installed, status));
  reg('cpm.disableAll', () => applyToggles(
    Object.fromEntries(installed.plugins.filter((p) => p.enabled).map((p) => [p.id, false])), installed, status));

  reg('cpm.openHomepage', (item) => item && item.plugin && item.plugin.homepage
    && vscode.env.openExternal(vscode.Uri.parse(item.plugin.homepage)));

  reg('cpm.openReadme', (item) => {
    if (!item || !item.plugin) return;
    const readme = path.join(item.plugin.root, 'README.md');
    if (fs.existsSync(readme)) vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(readme));
    else vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(item.plugin.root));
  });

  reg('cpm.revealFolder', (item) => item && item.plugin
    && vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(item.plugin.root)));

  // Refresh the marketplace catalog first, otherwise `plugin update` still sees the old commit.
  const updatePlugin = async (p) => {
    const ok = await cliAction(`${p.marketplace} 카탈로그 갱신`, ['plugin', 'marketplace', 'update', p.marketplace], installed)
      && await cliAction(`${p.name} 업데이트`, ['plugin', 'update', p.id], installed);
    return ok;
  };

  reg('cpm.update', async (item) => {
    if (!item || !item.plugin) return;
    if (await updatePlugin(item.plugin)) {
      vscode.window.showInformationMessage(`${item.plugin.name} 업데이트 완료 — 새 Claude 세션부터 적용됩니다.`);
    }
    status.refresh();
  });

  reg('cpm.updateAll', async () => {
    const targets = installed.plugins.filter((p) => installed.updates[p.id]);
    if (!targets.length) return;
    const done = [];
    for (const p of targets) if (await updatePlugin(p)) done.push(p.name);
    status.refresh();
    if (done.length) vscode.window.showInformationMessage(`${done.join(', ')} 업데이트 완료 — 새 Claude 세션부터 적용됩니다.`);
  });

  reg('cpm.checkUpdates', () => checkUpdates(true));

  reg('cpm.dedupe', async () => {
    const { redundant, groups } = installed.dupes;
    if (!redundant.length) {
      vscode.window.showInformationMessage('두 번 설치된 플러그인이 없습니다.');
      return;
    }
    const picks = redundant.map((id) => {
      const group = groups.find((g) => g.includes(id)) || [];
      return { label: id.split('@')[0], description: id.split('@')[1],
        detail: `남는 쪽: ${group.filter((x) => x !== id).join(', ')}`, picked: true, id };
    });
    const chosen = await vscode.window.showQuickPick(picks,
      { canPickMany: true, title: '끌 중복 설치본 선택 (같은 플러그인의 다른 설치본은 켜진 채 유지)' });
    if (!chosen || !chosen.length) return;
    applyToggles(Object.fromEntries(chosen.map((c) => [c.id, false])), installed, status);
  });

  reg('cpm.uninstall', async (item) => {
    if (!item || !item.plugin) return;
    const yes = await vscode.window.showWarningMessage(
      `${item.plugin.id} 플러그인을 제거할까요? 끄기와 달리 파일이 삭제됩니다.`, { modal: true }, '제거');
    if (yes) cliAction(`${item.plugin.name} 제거`, ['plugin', 'uninstall', item.plugin.id], installed);
  });

  reg('cpm.rec.refresh', () => recommend.refresh(true));

  reg('cpm.rec.open', (item) => {
    const r = item && item.rec;
    if (!r) return;
    const url = r.url || `https://github.com/search?q=${encodeURIComponent(r.name)}+claude&type=repositories`;
    vscode.env.openExternal(vscode.Uri.parse(url));
  });

  reg('cpm.rec.install', async (item) => {
    const r = item && item.rec;
    if (!r) return;
    if (r.kind === 'market') {
      await cliAction(`${r.name} 설치`, ['plugin', 'install', r.id, '--scope', 'user'], installed, recommend);
    } else {
      const yes = await vscode.window.showWarningMessage(
        `${r.repo}는 제3자 저장소입니다. 플러그인은 이 PC에서 훅과 스크립트를 실행할 수 있습니다. 등록할까요?`,
        { modal: true }, '등록');
      if (yes) await installFromGithub(r, installed, recommend);
    }
    status.refresh();
  });

  reg('cpm.showOutput', () => output.show());

  reg('cpm.translate', () => autoTranslate(installed, recommend, true));

  reg('cpm.editKorean', async () => {
    if (!fs.existsSync(i18n.USER_FILE)) fs.writeFileSync(i18n.USER_FILE, '{}\n', 'utf8');
    vscode.window.showTextDocument(vscode.Uri.file(i18n.USER_FILE));
  });

  context.subscriptions.push(output, status, installedView, recommendView,
    { dispose: () => watchers.forEach((w) => w.close()) },
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudePluginManager')) { installed.refresh(); status.refresh(); }
    }));
}

function deactivate() {}

module.exports = { activate, deactivate };
