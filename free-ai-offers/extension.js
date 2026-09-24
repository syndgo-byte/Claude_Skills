'use strict';
// "무료 AI 혜택" sidebar: free AI offers, when they end, and how to use them. No Claude tokens used.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const freeai = require('./lib/freeai');
const i18n = require('./lib/i18n');

const CACHE_KEY = 'fai.data';
const SEEN_KEY = 'fai.seen';
const CUSTOM_KEY = 'fai.custom';
const SEEDED_KEY = 'fai.seededLinks';
const TTL_MS = 6 * 60 * 60 * 1000;
const NEW_MODEL_DAYS = 14;
const CUSTOM_GRACE_DAYS = 7; // keep an expired custom link visible this long, then drop it
const CUSTOM_MAX = 60; // safety cap so the list can't grow forever even without deadlines
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

function config() {
  return vscode.workspace.getConfiguration('freeAiOffers');
}

function korean() {
  return config().get('koreanDescriptions') !== false;
}

function ko(key, original) {
  return (korean() && i18n.lookup(key)) || original || '';
}

function short(text, max) {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function md(text) {
  const s = new vscode.MarkdownString(text);
  s.supportThemeIcons = true;
  return s;
}

class FreeAIProvider {
  constructor(context) {
    this.context = context;
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
    this.data = context.globalState.get(CACHE_KEY);
    this.custom = context.globalState.get(CUSTOM_KEY) || [];
    this.seen = new Set(context.globalState.get(SEEN_KEY) || []);
    this.fresh = new Set();
    this.loading = false;
  }

  redraw() {
    this._emitter.fire();
  }

  trackable() {
    if (!this.data) return [];
    const d = this.data;
    return [...d.models.filter((m) => m.expires || this.isNewModel(m)), ...(d.promos || []),
      ...d.trial, ...d.renewable, ...d.permanent];
  }

  async saveCustom() {
    await this.context.globalState.update(CUSTOM_KEY, this.custom);
    this.redraw();
  }

  // Drops custom links whose deadline is well past, and caps the list so it can't grow forever.
  pruneCustom() {
    const cutoff = Date.now() - CUSTOM_GRACE_DAYS * 86400000;
    const before = this.custom.length;
    this.custom = this.custom.filter((c) => !c.deadline || Date.parse(`${c.deadline}T00:00:00Z`) >= cutoff);
    if (this.custom.length > CUSTOM_MAX) this.custom.length = CUSTOM_MAX;
    return before - this.custom.length;
  }

  // Keeps the "already seen" id set from growing forever: an id only needs to stay in it while
  // the item it names is still in the current dataset (so it doesn't get re-flagged as NEW).
  pruneSeen(currentIds) {
    const before = this.seen.size;
    this.seen = new Set([...this.seen].filter((id) => currentIds.has(id)));
    return before - this.seen.size;
  }

  isNewModel(m) {
    return Date.now() - m.created < NEW_MODEL_DAYS * 86400000;
  }

  async refresh(force) {
    if (this.loading) return [];
    if (!force && this.data && this.data.watched && Date.now() - this.data.fetchedAt < TTL_MS) return [];
    this.loading = true;
    this.redraw();
    let added = [];
    try {
      const data = await vscode.window.withProgress(
        { location: { viewId: 'fai.list' }, title: '무료 AI 혜택 수집 중' },
        () => freeai.collect(config().get('promoFeeds')));
      const firstRun = !this.seen.size;
      // News arrived in a later version; the first batch only seeds the seen list.
      const hadPromos = !!(this.data && this.data.watched);
      this.data = data;
      await this.context.globalState.update(CACHE_KEY, data);
      const items = this.trackable();
      added = firstRun ? [] : items.filter((x) => !this.seen.has(x.id) && (hadPromos || x.kind !== 'news'));
      this.fresh = new Set(added.map((x) => x.id));
      for (const x of items) this.seen.add(x.id);
      this.pruneSeen(new Set(items.map((x) => x.id)));
      await this.context.globalState.update(SEEN_KEY, [...this.seen]);
      if (this.pruneCustom()) await this.saveCustom();
    } finally {
      this.loading = false;
      this.redraw();
    }
    if (this.afterLoad) this.afterLoad();
    return added;
  }

  // English text shown in the view that still needs Korean.
  missingText() {
    const out = {};
    if (!this.data) return out;
    const add = (key, text) => { if (text && !i18n.lookup(key)) out[key] = text; };
    for (const m of this.data.models) add(`free:${m.id}`, m.description);
    for (const p of [...this.data.trial, ...this.data.renewable, ...this.data.permanent]) {
      add(`freed:${p.id}`, p.detail);
      if (p.note) add(`freen:${p.id}`, p.note);
    }
    for (const n of this.data.news) add(`news:${n.id}`, n.name);
    for (const n of this.data.promos || []) if (n.lang === 'en') add(`news:${n.id}`, n.name);
    for (const n of this.data.promos || []) if (n.summary) add(`newss:${n.id}`, n.summary);
    return out;
  }

  getTreeItem(el) {
    return el;
  }

  getChildren(el) {
    if (el) return el.children || [];
    if (!this.data) {
      const it = new vscode.TreeItem(this.loading ? '불러오는 중…' : '새로고침을 눌러 수집하세요');
      it.iconPath = new vscode.ThemeIcon(this.loading ? 'loading~spin' : 'info');
      return [it];
    }
    const d = this.data;
    const promos = d.promos || [];
    const limited = d.models.filter((m) => m.expires).sort((a, b) => a.daysLeft - b.daysLeft);
    const newModels = d.models.filter((m) => !m.expires && this.isNewModel(m));
    const otherModels = d.models.filter((m) => !m.expires && !this.isNewModel(m));
    const left = (x) => freeai.daysUntil(x.deadline ? new Date(`${x.deadline}T00:00:00Z`) : null);
    // Everything with a known end date, soonest first: limited models, dated news, links the user added.
    const deadlines = [
      ...limited.map((m) => ({ days: m.daysLeft, item: () => this.modelItem(m) })),
      ...promos.filter((n) => n.deadline && left(n) >= 0).map((n) => ({ days: left(n), item: () => this.promoItem(n) })),
      ...this.custom.filter((c) => c.deadline && left(c) >= 0).map((c) => ({ days: left(c), item: () => this.customItem(c) })),
    ].sort((a, b) => a.days - b.days);
    const sections = [];
    const section = (label, icon, items, desc, expanded = true) => {
      const s = new vscode.TreeItem(`${label} (${items.length})`,
        expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      s.iconPath = new vscode.ThemeIcon(icon);
      s.description = desc;
      s.children = items.length ? items : [placeholder()];
      sections.push(s);
    };
    section('마감 임박', 'watch', deadlines.map((x) => x.item()), '종료일 있는 혜택 · 가까운 순');
    section('내가 추가한 혜택', 'pin', this.custom.map((c) => this.customItem(c)), '＋ 버튼으로 링크 추가');
    const livePromos = promos.filter((n) => !n.deadline || left(n) >= 0);
    section('공식 무료 공지', 'verified', livePromos.filter((n) => n.official).map((n) => this.promoItem(n)),
      'Vercel·GitHub 변경 기록 60일');
    section('프로모션 뉴스', 'megaphone', livePromos.filter((n) => !n.official).map((n) => this.promoItem(n)), 'Google 뉴스·YouTube 14일');
    section('새로 나온 무료 모델', 'sparkle', newModels.map((m) => this.modelItem(m)), `최근 ${NEW_MODEL_DAYS}일`);
    section('가입 체험 크레딧', 'gift', d.trial.map((p) => this.providerItem(p)), '가입 시 1회 지급');
    section('주기적으로 충전되는 무료', 'history', d.renewable.map((p) => this.providerItem(p)), '일/월 단위 충전');
    section('상시 무료 API', 'infinity', d.permanent.map((p) => this.providerItem(p)), '무료 등급', false);
    section('OpenRouter 상시 무료 모델', 'server', otherModels.map((m) => this.modelItem(m)), '', false);
    section('개발자 커뮤니티 소식', 'comment-discussion', d.news.map((n) => this.newsItem(n)), 'Hacker News 30일', false);
    const info = new vscode.TreeItem(`${new Date(d.fetchedAt).toLocaleString()} 기준`);
    info.iconPath = new vscode.ThemeIcon('info');
    info.tooltip = md(`출처: [Free-LLM 목록](${freeai.DIRECTORY_PAGE}) · [OpenRouter](https://openrouter.ai/models?max_price=0)`
      + ' · [Vercel AI Gateway](https://vercel.com/ai-gateway/models) · [Vercel 변경 기록](https://vercel.com/changelog)'
      + ' · [GitHub 변경 기록](https://github.blog/changelog/) · Google 뉴스 · [Hacker News](https://news.ycombinator.com)'
      + '\n\n6시간마다 자동 갱신. Claude 토큰을 쓰지 않습니다. 공지 피드는 설정 `freeAiOffers.promoFeeds`에 더 넣을 수 있습니다.');
    sections.push(info);
    for (const e of d.errors) {
      const it = new vscode.TreeItem(e);
      it.iconPath = new vscode.ThemeIcon('warning');
      sections.push(it);
    }
    return sections;
  }

  newTag(id) {
    return this.fresh.has(id) ? 'NEW · ' : '';
  }

  modelItem(m) {
    const it = new vscode.TreeItem(m.name.replace(/\s*\(free\)\s*$/i, ''));
    it.entry = m;
    it.contextValue = 'free.model';
    const when = m.expires ? `D-${m.daysLeft} · ${m.expires}까지` : this.isNewModel(m) ? `${new Date(m.created).toLocaleDateString()} 출시` : '';
    it.description = `${this.newTag(m.id)}${when}${when ? ' · ' : ''}${short(ko(`free:${m.id}`, m.description), 50)}`;
    const urgent = m.expires && m.daysLeft <= 3;
    it.iconPath = new vscode.ThemeIcon(m.expires ? 'watch' : 'hubot',
      urgent ? new vscode.ThemeColor('charts.red') : this.fresh.has(m.id) ? new vscode.ThemeColor('charts.green') : undefined);
    it.tooltip = md([
      `**${m.name}**`,
      m.expires ? `$(watch) **${m.expires}까지 무료** (D-${m.daysLeft})` : '$(check) 종료일 없음',
      '',
      ko(`free:${m.id}`, m.description) || '_설명 없음_',
      '',
      `- 모델 ID: \`${m.id}\``,
      m.context ? `- 컨텍스트: ${m.context.toLocaleString()} 토큰` : '',
      '',
      '클릭하면 사용법 안내가 열립니다.',
    ].join('\n'));
    it.command = { command: 'fai.guide', title: '사용법', arguments: [it] };
    return it;
  }

  providerItem(p) {
    const it = new vscode.TreeItem(p.name);
    it.entry = p;
    it.contextValue = 'free.provider';
    const detail = ko(`freed:${p.id}`, p.detail);
    it.description = `${this.newTag(p.id)}${short(detail, 70)}`;
    it.iconPath = new vscode.ThemeIcon(p.group === 'trial' ? 'gift' : p.group === 'renewable' ? 'history' : 'cloud',
      this.fresh.has(p.id) ? new vscode.ThemeColor('charts.green') : undefined);
    it.tooltip = md([
      `**${p.name}**`,
      '',
      detail || '_조건 정보 없음_',
      p.note ? `\n$(warning) ${ko(`freen:${p.id}`, p.note)}` : '',
      '',
      p.card ? `- 가입 조건: ${p.card}` : '',
      p.models && p.models !== 'See provider' ? `- 주요 모델: ${p.models}` : '',
      p.baseUrl ? `- Base URL: \`${p.baseUrl}\`` : '',
      '',
      '클릭하면 사용법 안내가 열립니다.',
    ].filter((l) => l !== null).join('\n'));
    it.command = { command: 'fai.guide', title: '사용법', arguments: [it] };
    return it;
  }

  promoItem(n) {
    const days = freeai.daysUntil(n.deadline ? new Date(`${n.deadline}T00:00:00Z`) : null);
    const it = new vscode.TreeItem(short(n.lang === 'en' ? ko(`news:${n.id}`, n.name) : n.name, 80));
    it.entry = n;
    it.contextValue = 'free.news';
    it.description = `${this.newTag(n.id)}${days !== null ? `D-${days} · ${n.deadline}까지 · ` : ''}${n.source} · ${n.date.slice(5, 10)}`;
    it.iconPath = new vscode.ThemeIcon(days !== null ? 'watch' : 'megaphone',
      days !== null && days <= 3 ? new vscode.ThemeColor('charts.red') : this.fresh.has(n.id) ? new vscode.ThemeColor('charts.green') : undefined);
    it.tooltip = md(`**${n.name}**${n.lang === 'en' && ko(`news:${n.id}`, '') ? `\n\n${ko(`news:${n.id}`, '')}` : ''}`
      + `${n.summary ? `\n\n> ${ko(`newss:${n.id}`, n.summary)}` : ''}`
      + `\n\n${n.source} · ${n.date.slice(0, 10)}${n.deadline ? `\n\n$(watch) 마감 ${n.deadline} (제목에서 추출, 원문 확인 필요)` : ''}`);
    it.command = { command: 'vscode.open', title: '열기', arguments: [vscode.Uri.parse(n.url)] };
    return it;
  }

  customItem(c) {
    const days = freeai.daysUntil(c.deadline ? new Date(`${c.deadline}T00:00:00Z`) : null);
    const it = new vscode.TreeItem(short(c.name, 80));
    it.entry = c;
    it.contextValue = 'free.custom';
    it.description = days === null ? c.source : days < 0 ? `마감됨 · ${c.source}` : `D-${days} · ${c.deadline}까지 · ${c.source}`;
    it.iconPath = new vscode.ThemeIcon(days !== null && days < 0 ? 'circle-slash' : 'pin',
      days !== null && days >= 0 && days <= 3 ? new vscode.ThemeColor('charts.red') : undefined);
    it.tooltip = md(`**${c.source}**\n\n${c.text || ''}\n\n${c.deadline ? `$(watch) 마감 ${c.deadline} (본문에서 추출)` : '$(info) 마감일을 찾지 못함'}`);
    it.command = { command: 'vscode.open', title: '열기', arguments: [vscode.Uri.parse(c.url)] };
    return it;
  }

  newsItem(n) {
    const it = new vscode.TreeItem(short(ko(`news:${n.id}`, n.name), 80));
    it.entry = n;
    it.contextValue = 'free.news';
    it.description = `▲${n.points} · ${n.date.slice(0, 10)}`;
    it.iconPath = new vscode.ThemeIcon('megaphone');
    it.tooltip = md(`**${n.name}**\n\n${ko(`news:${n.id}`, '')}\n\n▲${n.points} · 댓글 ${n.comments} · ${n.date.slice(0, 10)}`);
    it.command = { command: 'vscode.open', title: '열기', arguments: [vscode.Uri.parse(n.url)] };
    return it;
  }
}

function placeholder() {
  const it = new vscode.TreeItem('현재 없음');
  it.iconPath = new vscode.ThemeIcon('dash');
  return it;
}

// ---------- Usage guide ----------

function vercelGuide(m, data) {
  const base = 'https://ai-gateway.vercel.sh/v1';
  const promo = (data.promos || []).find((n) => n.official && n.deadline
    && n.name.toLowerCase().includes(m.name.replace(/ · Vercel$/, '').toLowerCase().replace(/\s*\(free\)|\s*free$/i, '')));
  return [
    `# ${m.name.replace(/ · Vercel$/, '')} (Vercel AI Gateway)`,
    '',
    promo ? `> **${promo.deadline}까지 무료** — Vercel 공식 공지: [${promo.name}](${promo.url})`
      : '> 현재 Vercel AI Gateway에서 가격이 0으로 표시된 모델입니다. 종료일은 Vercel 변경 기록에서 확인하세요.',
    '',
    ko(`free:${m.id}`, m.description),
    '',
    `- 모델 ID: \`${m.id}\``,
    m.context ? `- 컨텍스트: ${m.context.toLocaleString()} 토큰` : '',
    `- 모델 페이지: ${m.url}`,
    '',
    '## 1. API 키 받기',
    '',
    'Vercel에 로그인한 뒤 대시보드의 AI Gateway → API Keys에서 키를 만듭니다. 환경 변수 이름은 보통 `AI_GATEWAY_API_KEY`입니다.',
    '',
    '## 2. 바로 호출해 보기 (OpenAI 호환)',
    '',
    '```bash',
    `curl ${base}/chat/completions \\`,
    '  -H "Authorization: Bearer $AI_GATEWAY_API_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '{"model": "${m.id}", "messages": [{"role": "user", "content": "안녕"}]}'`,
    '```',
    '',
    '```ts',
    "// AI SDK: 'provider/model' 문자열을 쓰면 AI Gateway로 호출됩니다.",
    "import { generateText } from 'ai';",
    `const { text } = await generateText({ model: '${m.id}', prompt: '안녕' });`,
    '```',
    '',
    '## 3. 도구에 연결하기',
    '',
    `- **Cline / Roo Code / Continue / Codex CLI 등 OpenAI 호환 도구**: Base URL \`${base}\`, 키, 모델 \`${m.id}\``,
    `- **Aider**: \`aider --openai-api-base ${base} --openai-api-key <AI_GATEWAY_API_KEY> --model openai/${m.id}\``,
    '- **Claude Code**: Vercel 문서에 안내된 Anthropic 호환 주소가 있으면 `ANTHROPIC_BASE_URL`로 연결할 수 있습니다. 그 세션은 Claude가 아닌 이 모델로 동작하니 별도 터미널에서만 설정하세요.',
    '',
    '## 주의',
    '',
    '- 무료 기간이 끝나면 같은 키로 요금이 청구될 수 있습니다. Vercel 결제 설정과 사용량을 확인하세요.',
    '- 회사 코드나 비밀값은 보내지 마세요.',
  ].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
}

function modelGuide(m, data) {
  if (m.gateway === 'vercel') return vercelGuide(m, data);
  const orLimit = (data.renewable.find((p) => /openrouter/i.test(p.name)) || {}).detail;
  return [
    `# ${m.name}`,
    '',
    m.expires ? `> **${m.expires}까지 무료** (D-${m.daysLeft}). 이후에는 유료로 바뀌거나 사라질 수 있습니다.`
      : '> 현재 종료일이 공지되지 않은 무료 모델입니다.',
    '',
    ko(`free:${m.id}`, m.description),
    '',
    `- 모델 ID: \`${m.id}\``,
    m.context ? `- 컨텍스트: ${m.context.toLocaleString()} 토큰` : '',
    `- 모델 페이지: ${m.url}`,
    orLimit ? `- OpenRouter 무료 한도: ${orLimit}` : '',
    '',
    '## 1. API 키 받기',
    '',
    'https://openrouter.ai/keys 에서 가입 후 키를 만듭니다. 무료 모델(`:free`)은 결제 없이 쓸 수 있습니다.',
    '',
    '## 2. 바로 호출해 보기',
    '',
    '```bash',
    `curl ${OPENROUTER_BASE}/chat/completions \\`,
    '  -H "Authorization: Bearer $OPENROUTER_API_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '{"model": "${m.id}", "messages": [{"role": "user", "content": "안녕"}]}'`,
    '```',
    '',
    '```python',
    'from openai import OpenAI',
    `client = OpenAI(base_url="${OPENROUTER_BASE}", api_key="<OPENROUTER_API_KEY>")`,
    `r = client.chat.completions.create(model="${m.id}", messages=[{"role": "user", "content": "안녕"}])`,
    'print(r.choices[0].message.content)',
    '```',
    '',
    '## 3. 도구에 연결하기',
    '',
    `- **Cline / Roo Code (VS Code)**: API Provider를 OpenRouter로, Model을 \`${m.id}\`로 설정`,
    `- **Aider**: \`aider --model openrouter/${m.id}\` (환경 변수 \`OPENROUTER_API_KEY\` 필요)`,
    `- **OpenAI 호환 도구 (Codex CLI, Continue, Open WebUI 등)**: Base URL \`${OPENROUTER_BASE}\`, API 키, 모델 \`${m.id}\``,
    '- **Claude Code**: OpenRouter의 Anthropic 호환 주소로 연결할 수 있습니다. 이 경우 그 세션은 Claude가 아닌 이 모델로 동작하며,'
      + ' 도구 호출 지원 여부에 따라 잘 안 될 수 있습니다. 평소 Claude 구독 세션과 섞이지 않게 별도 터미널에서만 설정하세요.',
    '',
    '```bash',
    'export ANTHROPIC_BASE_URL="https://openrouter.ai/api"',
    'export ANTHROPIC_AUTH_TOKEN="<OPENROUTER_API_KEY>"',
    'export ANTHROPIC_API_KEY=""',
    `export ANTHROPIC_MODEL="${m.id}"`,
    '```',
    '',
    '## 주의',
    '',
    '- 무료 모델은 요청 내용이 제공사 쪽에 기록·학습에 쓰일 수 있습니다. 회사 코드나 비밀값은 보내지 마세요.',
    '- 한도와 종료일은 수시로 바뀝니다. 모델 페이지에서 최종 확인하세요.',
  ].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
}

function providerGuide(p) {
  const base = p.baseUrl;
  const openaiLike = base && /\/v\d|openai/i.test(base) && !/generativelanguage|cloudflare|replicate|dashscope|cohere/i.test(base);
  const lines = [
    `# ${p.name}`,
    '',
    `> ${p.group === 'trial' ? '가입 체험 크레딧' : p.group === 'renewable' ? '주기적으로 충전되는 무료' : '상시 무료 등급'}`
      + ` — ${ko(`freed:${p.id}`, p.detail) || '조건은 제공사 페이지 확인'}`,
    '',
    p.note ? `- ⚠️ ${ko(`freen:${p.id}`, p.note)}` : '',
    p.card ? `- 가입 조건: ${p.card}` : '',
    p.models && p.models !== 'See provider' ? `- 주요 모델: ${p.models}` : '',
    p.url ? `- 가입·키 발급: ${p.url}` : '',
    base ? `- Base URL: \`${base}\`` : '',
    '',
    '## 1. API 키 받기',
    '',
    p.url ? `${p.url} 에서 가입한 뒤 콘솔의 API Keys 메뉴에서 키를 만듭니다.` : '제공사 콘솔에서 키를 만듭니다.',
  ];
  if (openaiLike) {
    lines.push(
      '', '## 2. 바로 호출해 보기 (OpenAI 호환)', '',
      '```bash',
      `curl ${base.replace(/\/$/, '')}/chat/completions \\`,
      '  -H "Authorization: Bearer $API_KEY" \\',
      '  -H "Content-Type: application/json" \\',
      '  -d \'{"model": "<모델 이름>", "messages": [{"role": "user", "content": "안녕"}]}\'',
      '```', '',
      '```python',
      'from openai import OpenAI',
      `client = OpenAI(base_url="${base}", api_key="<API_KEY>")`,
      'r = client.chat.completions.create(model="<모델 이름>", messages=[{"role": "user", "content": "안녕"}])',
      'print(r.choices[0].message.content)',
      '```', '',
      '모델 이름은 제공사의 모델 목록 페이지에서 확인하세요. 대부분 `GET ' + base.replace(/\/$/, '') + '/models`로도 조회됩니다.',
      '', '## 3. 도구에 연결하기', '',
      `- **Cline / Roo Code (VS Code)**: API Provider를 "OpenAI Compatible"로, Base URL \`${base}\`, 키, 모델 이름 입력`,
      `- **Aider**: \`aider --openai-api-base ${base} --openai-api-key <API_KEY> --model openai/<모델 이름>\``,
      `- **Codex CLI 등 OpenAI 호환 도구**: \`OPENAI_BASE_URL=${base}\`, \`OPENAI_API_KEY=<API_KEY>\``,
      '- **Claude Code**: Anthropic 호환 주소를 따로 제공하는 곳만 연결됩니다. 제공사 문서에서 "Anthropic compatible" 또는 "Claude Code" 안내를 확인하세요.',
    );
  } else {
    lines.push('', '## 2. 사용하기', '',
      base ? `이 제공사는 자체 API 형식(\`${base}\`)을 씁니다. 제공사 문서의 예제와 SDK를 확인하세요.`
        : '제공사 문서의 빠른 시작 안내를 따르세요.');
  }
  lines.push('', '## 주의', '',
    '- 무료 등급은 요청 내용이 기록·학습에 쓰일 수 있습니다. 회사 코드나 비밀값은 보내지 마세요.',
    '- 조건은 수시로 바뀝니다. 가입 전에 제공사 페이지에서 최종 확인하세요.');
  return lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
}

async function openGuide(context, item, data) {
  const e = item && item.entry;
  if (!e || !data) return;
  const text = e.kind === 'model' ? modelGuide(e, data) : providerGuide(e);
  const dir = path.join(context.globalStorageUri.fsPath, 'guides');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${e.id.replace(/[^a-z0-9._-]+/gi, '_')}.md`);
  fs.writeFileSync(file, text, 'utf8');
  await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(file));
}

// ---------- Activation ----------

function activate(context) {
  const provider = new FreeAIProvider(context);
  const view = vscode.window.createTreeView('fai.list', { treeDataProvider: provider, showCollapseAll: true });
  provider.afterLoad = () => {
    if (!korean()) return;
    const entries = provider.missingText();
    if (!Object.keys(entries).length) return;
    i18n.translate(entries).then(() => provider.redraw());
  };

  const run = async (force, notify) => {
    const added = await provider.refresh(force);
    if (!notify || !added.length) return;
    const names = added.slice(0, 4).map((x) => x.name).join(', ');
    const pick = await vscode.window.showInformationMessage(
      `새 무료 AI 혜택 ${added.length}개: ${names}${added.length > 4 ? ' 외' : ''}`, '보기');
    if (pick) vscode.commands.executeCommand('fai.list.focus');
  };

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg('fai.refresh', () => run(true, true));
  reg('fai.guide', (item) => openGuide(context, item, provider.data));
  reg('fai.open', (item) => {
    const e = item && item.entry;
    if (e && e.url) vscode.env.openExternal(vscode.Uri.parse(e.url));
  });
  const addLink = async (url, quiet) => {
    if (provider.custom.some((c) => c.url === url)) {
      if (!quiet) vscode.window.showInformationMessage('이미 추가된 링크입니다.');
      return;
    }
    try {
      const entry = await vscode.window.withProgress(
        { location: { viewId: 'fai.list' }, title: '링크 읽는 중' }, () => freeai.readLink(url));
      provider.custom.unshift(entry);
      await provider.saveCustom();
      if (!quiet) {
        vscode.window.showInformationMessage(entry.deadline
          ? `추가함: ${entry.name} — 마감 ${entry.deadline}` : `추가함: ${entry.name} — 마감일은 본문에서 찾지 못했습니다.`);
      }
    } catch (e) {
      if (!quiet) vscode.window.showErrorMessage(`링크를 읽지 못했습니다: ${e.message}`);
    }
  };

  reg('fai.addLink', async () => {
    let clip = '';
    try { clip = (await vscode.env.clipboard.readText()).trim(); } catch { /* no clipboard */ }
    const url = await vscode.window.showInputBox({
      title: '무료 혜택 링크 추가 (Threads, X, 블로그, 공지 등)',
      prompt: '페이지 미리보기 글을 읽어 마감일(예: 10월 7일까지)을 찾아 둡니다.',
      value: /^https?:\/\//.test(clip) ? clip : '',
      validateInput: (v) => (/^https?:\/\/\S+$/.test(v.trim()) ? null : 'http(s) 주소를 입력하세요'),
    });
    if (url) addLink(url.trim(), false);
  });

  reg('fai.removeCustom', async (item) => {
    const e = item && item.entry;
    if (!e) return;
    provider.custom = provider.custom.filter((c) => c.id !== e.id);
    await provider.saveCustom();
  });

  reg('fai.cleanup', async () => {
    const removed = provider.pruneCustom();
    if (removed) await provider.saveCustom();
    vscode.window.showInformationMessage(removed
      ? `마감 지난 지 ${CUSTOM_GRACE_DAYS}일 넘은 항목 ${removed}개를 지웠습니다.`
      : '지울 항목이 없습니다. 마감된 지 오래된 항목만 자동으로 지워집니다.');
  });

  reg('fai.copy', async (item) => {
    const e = item && item.entry;
    const text = e && (e.kind === 'model' ? e.id : e.baseUrl);
    if (!text) return;
    await vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage(`복사함: ${text}`);
  });

  // Posts shared while this feature was built, added once as examples.
  const SEED_LINKS = [
    'https://www.threads.com/@aicoffeechat/post/DdpYr8fkzbj',
    'https://www.threads.com/@takepage_/post/DdgfOXOk9zb',
  ];
  const seeded = new Set(context.globalState.get(SEEDED_KEY) || []);
  (async () => {
    for (const url of SEED_LINKS.filter((u) => !seeded.has(u))) {
      await addLink(url, true);
      seeded.add(url);
    }
    context.globalState.update(SEEDED_KEY, [...seeded]);
  })();

  // Cached data shows at once; a fresh fetch runs when older than 6 hours, then every 6 hours.
  setTimeout(() => run(false, true), 8000);
  const timer = setInterval(() => run(true, true), TTL_MS);
  context.subscriptions.push(view, { dispose: () => clearInterval(timer) });
  if (provider.data) setTimeout(() => provider.afterLoad(), 3000);
}

function deactivate() {}

module.exports = { activate, deactivate };
