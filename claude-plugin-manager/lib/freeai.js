'use strict';
// Collects free AI offers from public sources. No Claude calls.
const https = require('https');

const DIRECTORY_URL = 'https://raw.githubusercontent.com/nejib1/Free-LLM/HEAD/README.md';
const DIRECTORY_PAGE = 'https://github.com/nejib1/Free-LLM';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/models';
const NEWS_QUERIES = ['free credits', 'free tier', 'free API', 'free access', 'free for a limited time'];
const AI_WORDS = /\b(ai|llms?|gpt|chatgpt|claude|gemini|models?|tokens?|inference|grok|deepseek|qwen|llama|mistral|openai|anthropic|copilot|coding agent)\b/i;

function get(url, json) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'claude-plugin-manager' }, timeout: 20000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`${new URL(url).host} ${res.statusCode}`));
        try { resolve(json ? JSON.parse(body) : body); } catch (e) { reject(e); }
      });
    }).on('error', reject).on('timeout', function () { this.destroy(new Error(`${new URL(url).host} 시간 초과`)); });
  });
}

// ---------- OpenRouter: free models, some with an end date ----------

async function openRouter() {
  const data = await get(OPENROUTER_URL, true);
  openRouterRaw = data.data || [];
  const now = Date.now();
  return (data.data || [])
    .filter((m) => m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0)
    .map((m) => {
      const exp = m.expiration_date && !m.expiration_date.startsWith('2098') ? m.expiration_date : null;
      return {
        kind: 'model',
        id: m.id,
        name: m.name,
        description: (m.description || '').replace(/\s+/g, ' ').slice(0, 400),
        context: m.context_length,
        created: m.created * 1000,
        expires: exp,
        daysLeft: exp ? Math.ceil((Date.parse(`${exp}T23:59:59Z`) - now) / 86400000) : null,
        url: `https://openrouter.ai/${m.id}`,
      };
    })
    .filter((m) => m.daysLeft === null || m.daysLeft >= 0);
}

// ---------- Free-LLM directory (markdown tables) ----------

function stripMd(text) {
  return (text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function linkOf(text) {
  const m = (text || '').match(/\]\((https?:[^)\s]+)\)/) || (text || '').match(/href="(https?:[^"]+)"/);
  return m ? m[1] : undefined;
}

// Rows of the first table under a heading that contains `title`.
function tableUnder(md, title) {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{2,4}\s/.test(l) && l.includes(title));
  if (start < 0) return [];
  const rows = [];
  let header = null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (/^#{2,4}\s/.test(l)) break;
    if (!l.startsWith('|')) { if (header && rows.length) break; continue; }
    const cells = l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (!header) { header = cells.map(stripMd); continue; }
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    rows.push(Object.fromEntries(header.map((h, j) => [h, cells[j] || ''])));
  }
  return rows;
}

async function directory() {
  const md = await get(DIRECTORY_URL, false);
  const baseUrls = {};
  for (const r of tableUnder(md, 'Quick Reference')) {
    baseUrls[stripMd(r.Provider).toLowerCase()] = stripMd(r['Base URL']);
  }
  const make = (group, r, detail) => {
    const name = stripMd(r.Provider).replace(/⚠️.*$/, '').trim();
    return {
      kind: 'provider',
      group,
      id: `${group}:${name}`,
      name,
      url: linkOf(r.Provider),
      card: stripMd(r['Credit Card?']),
      detail,
      models: stripMd(r['Key Models']),
      baseUrl: baseUrls[name.toLowerCase()],
      note: /⚠️/.test(r.Provider) ? stripMd(r.Provider.split('⚠️')[1]) : '',
    };
  };
  return {
    permanent: tableUnder(md, 'Permanent Free').map((r) => make('permanent', r,
      [r['Rate Limit'], r['Daily Limit'], r['Monthly Limit']].map(stripMd).filter((x) => x && x !== '-').join(' · '))),
    renewable: tableUnder(md, 'Renewable Credits').map((r) => make('renewable', r,
      [r['Free Offer'], r['Rate Limit']].map(stripMd).filter((x) => x && x !== '-').join(' · '))),
    trial: tableUnder(md, 'Trial Credits').map((r) => {
      const item = make('trial', r, [r['Credit Amount'], r.Expiry].map(stripMd).filter((x) => x && x !== '—').join(' · valid for '));
      item.amount = stripMd(r['Credit Amount']);
      item.expiry = stripMd(r.Expiry);
      return item;
    }),
  };
}

// ---------- Hacker News: fresh announcements ----------

async function news(days) {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const seen = new Map();
  for (const q of NEWS_QUERIES) {
    const url = `https://hn.algolia.com/api/v1/search?tags=story&query=${encodeURIComponent(q)}`
      + `&numericFilters=created_at_i>${since}&hitsPerPage=40`;
    const data = await get(url, true).catch(() => ({ hits: [] }));
    for (const h of data.hits || []) {
      if (!h.title || !AI_WORDS.test(h.title) || !/free/i.test(h.title) || seen.has(h.objectID)) continue;
      seen.set(h.objectID, {
        kind: 'news',
        id: `hn:${h.objectID}`,
        name: h.title,
        url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
        discussion: `https://news.ycombinator.com/item?id=${h.objectID}`,
        points: h.points || 0,
        comments: h.num_comments || 0,
        date: h.created_at,
      });
    }
  }
  return [...seen.values()].sort((a, b) => b.points - a.points).slice(0, 25);
}

// ---------- Deadlines in free text ("10월 7일까지", "until October 7", "2026-10-07") ----------

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

function deadlineIn(text, publishedAt) {
  const t = text || '';
  const ref = publishedAt ? new Date(publishedAt) : new Date();
  const mk = (y, m, d) => {
    let date = new Date(Date.UTC(y || ref.getUTCFullYear(), m - 1, d));
    // A month/day without a year that is well before the post date means next year.
    if (!y && date < ref - 60 * 86400000) date = new Date(Date.UTC(ref.getUTCFullYear() + 1, m - 1, d));
    return date;
  };
  let m = t.match(/(20\d{2})[.\-/년]\s*(\d{1,2})[.\-/월]\s*(\d{1,2})일?\s*(까지|마감|종료)?/);
  if (m && (m[4] || /까지|마감|종료|until|by|through|ends?/i.test(t))) return mk(+m[1], +m[2], +m[3]);
  m = t.match(/(\d{1,2})월\s*(\d{1,2})일\s*(까지|마감|종료|이전)/);
  if (m) return mk(0, +m[1], +m[2]);
  m = t.match(/(\d{1,2})\s*(?:days?\s+left|일\s*남)/i);
  if (m) return new Date(ref.getTime() + +m[1] * 86400000);
  m = t.match(/(?:until|by|through|thru|ends?(?: on)?|before|deadline:?)\s+(?:(?:mon|tues|wednes|thurs|fri|satur|sun)day,?\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(20\d{2}))?/i);
  if (m) return mk(m[3] ? +m[3] : 0, MONTHS[m[1].toLowerCase()], +m[2]);
  return null;
}

function daysUntil(date) {
  return date ? Math.ceil((date.getTime() + 86399000 - Date.now()) / 86400000) : null;
}

// ---------- News: Google News RSS (Korean + English) ----------

const PROMO_QUERIES = [
  ['AI 무료 크레딧', 'ko'], ['AI 무료 제공 기간', 'ko'], ['클로드 크레딧', 'ko'], ['코딩 에이전트 무료', 'ko'],
  ['free AI credits', 'en'], ['Claude credits free', 'en'], ['free tier LLM API', 'en'],
];
const PROMO_AI = /(AI|인공지능|LLM|GPT|챗GPT|Claude|클로드|Gemini|제미나이|코딩|에이전트|Kiro|키로|Copilot|코파일럿|Cursor|커서|API|모델|OpenAI|오픈AI|Anthropic|앤트로픽|DeepSeek|딥시크|Grok|그록)/i;
// A watched model name (e.g. "Jev") counts as AI context even without generic AI words.
function aboutAI(text, names) {
  const lower = text.toLowerCase();
  return PROMO_AI.test(text) || (names || []).some((n) => lower.includes(n.toLowerCase()));
}
const PROMO_FREE = /(무료|크레딧|free|credit|공짜|제공)/i;
const SPAM = /(카지노|슬롯|바카라|토토|베팅|casino|slot|betting|poker|포커)/i;
// Courses, reviews and "best of" lists are not offers.
const NOISE = /(교육생|교육|모집|채용|강좌|강의|세미나|best |alternatives|review|tested|vs\.? |top \d+|sale|% off)/i;

function decodeXml(s) {
  return (s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

async function promoNews(days, names) {
  const seen = new Map();
  const queries = [...PROMO_QUERIES, ...(names || []).flatMap((n) => [[`"${n}" 무료`, 'ko'], [`"${n}" free`, 'en']])];
  for (const [q, lang] of queries) {
    const loc = lang === 'ko' ? 'hl=ko&gl=KR&ceid=KR:ko' : 'hl=en-US&gl=US&ceid=US:en';
    const xml = await get(`https://news.google.com/rss/search?q=${encodeURIComponent(`${q} when:${days}d`)}&${loc}`, false)
      .catch(() => '');
    for (const item of xml.split('<item>').slice(1)) {
      const title = decodeXml((item.match(/<title>([\s\S]*?)<\/title>/) || [])[1]);
      const link = decodeXml((item.match(/<link>([\s\S]*?)<\/link>/) || [])[1]);
      const pub = (item.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1];
      const source = decodeXml((item.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1]);
      const headline = source && title.endsWith(` - ${source}`) ? title.slice(0, -source.length - 3) : title;
      if (!headline || SPAM.test(headline) || NOISE.test(headline) || !aboutAI(headline, names) || !PROMO_FREE.test(headline)) continue;
      const key = headline.replace(/\s+/g, '').slice(0, 40);
      if (seen.has(key)) continue;
      const deadline = deadlineIn(headline, pub);
      seen.set(key, {
        kind: 'news', source: source || 'Google News', lang,
        id: `gn:${key}`, name: headline, url: link,
        date: pub ? new Date(pub).toISOString() : new Date().toISOString(),
        deadline: deadline ? deadline.toISOString().slice(0, 10) : null,
        daysLeft: daysUntil(deadline),
      });
    }
  }
  return [...seen.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 40);
}

// ---------- Official vendor changelogs (RSS/Atom): "X is free through September 30" ----------

const VENDOR_FEEDS = [
  { name: 'Vercel', url: 'https://vercel.com/atom' },
  { name: 'GitHub', url: 'https://github.blog/changelog/feed/' },
];
const FEED_AI = /(AI Gateway|model|LLM|Copilot|agent|GPT|Claude|Gemini|Grok|GLM|MiniMax|DeepSeek|Qwen|Llama|search|inference|tokens?)/i;

async function vendorFeeds(days, extraFeeds) {
  const since = Date.now() - days * 86400000;
  const out = [];
  for (const feed of [...VENDOR_FEEDS, ...(extraFeeds || [])]) {
    const xml = await get(feed.url, false).catch(() => '');
    const entries = xml.includes('<entry') ? xml.split(/<entry[\s>]/).slice(1) : xml.split('<item>').slice(1);
    for (const e of entries) {
      const title = decodeXml((e.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1]).trim();
      const link = (e.match(/<link[^>]*href="([^"]+)"/) || e.match(/<link>([\s\S]*?)<\/link>/) || [])[1];
      const date = (e.match(/<(?:published|updated|pubDate)>([^<]+)</) || [])[1];
      if (!title || !date || Date.parse(date) < since) continue;
      const body = decodeXml((e.match(/<(?:content|summary|description)[^>]*>([\s\S]*?)<\/(?:content|summary|description)>/) || [])[1])
        .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      const text = `${title}. ${body}`;
      if (!/\bfree\b|no cost|\$0\b|complimentary/i.test(text) || !FEED_AI.test(text)) continue;
      // Keep the sentence that says it is free; that is what the list shows.
      const sentence = (text.match(/[^.]*\b(free|no cost|complimentary)\b[^.]*\./i) || [title])[0].trim();
      // An offer says so ("is free", "free through", "for free"); a passing "free" in an unrelated post does not count.
      const OFFER = /\b(is|are|now|for|stays?|remains?) free\b|\bfree (through|until|thru|on|for|to use|of charge)\b|\bno cost\b|\bcomplimentary\b/i;
      if (!/\bfree\b/i.test(title) && !OFFER.test(sentence)) continue;
      if (/free up|free domain|free tier that/i.test(title)) continue;
      const deadline = deadlineIn(sentence, date) || deadlineIn(text, date);
      out.push({
        kind: 'news', source: `${feed.name} 공식`, lang: 'en', official: true,
        id: `feed:${link || title}`, name: title, summary: sentence.slice(0, 300), url: decodeXml(link || feed.url),
        date: new Date(date).toISOString(),
        deadline: deadline ? deadline.toISOString().slice(0, 10) : null,
        daysLeft: daysUntil(deadline),
      });
    }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

// ---------- YouTube search (newest uploads; reads titles and description snippets) ----------

function relativeToDate(text) {
  const t = text || '';
  const m = t.match(/(\d+)\s*(초|분|시간|일|주|개월|달|년|second|minute|hour|day|week|month|year)/i);
  if (!m) return new Date();
  const n = +m[1];
  const unit = m[2].toLowerCase();
  const day = 86400000;
  const ms = /초|second/.test(unit) ? 1000 : /분|minute/.test(unit) ? 60000 : /시간|hour/.test(unit) ? 3600000
    : /일|day/.test(unit) ? day : /주|week/.test(unit) ? 7 * day : /개월|달|month/.test(unit) ? 30 * day : 365 * day;
  return new Date(Date.now() - n * ms);
}

async function youtube(query, days, retry = 2) {
  const html = await new Promise((resolve, reject) => {
    // sp=CAI%3D sorts by upload date.
    https.get(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=CAI%253D`,
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ko,en' }, timeout: 20000 }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve(body));
      }).on('error', reject).on('timeout', function () { this.destroy(new Error('YouTube 시간 초과')); });
  });
  const m = html.match(/var ytInitialData = (\{.*?\});<\/script>/s);
  if (!m) {
    // YouTube sometimes answers quick repeat requests with a page without results; wait and retry.
    if (!retry) return [];
    await new Promise((res) => setTimeout(res, 2000));
    return youtube(query, days, retry - 1);
  }
  const out = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (o.videoRenderer) {
      const v = o.videoRenderer;
      const title = (v.title.runs || []).map((r) => r.text).join('');
      const snippet = (v.detailedMetadataSnippets || [])
        .map((s) => s.snippetText.runs.map((r) => r.text).join('')).join(' ');
      const date = relativeToDate(v.publishedTimeText && v.publishedTimeText.simpleText);
      out.push({ id: v.videoId, title, snippet, date, channel: v.ownerText && v.ownerText.runs[0].text });
      return;
    }
    for (const k in o) walk(o[k]);
  };
  walk(JSON.parse(m[1]));
  const since = Date.now() - days * 86400000;
  return out.filter((v) => v.date.getTime() >= since);
}

// Full video description; search snippets change per request and often miss the deadline line.
function videoDescription(id) {
  return new Promise((resolve) => {
    https.get(`https://www.youtube.com/watch?v=${id}`,
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ko,en' }, timeout: 20000 }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          const m = body.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/);
          try { resolve(m ? JSON.parse(`"${m[1]}"`) : ''); } catch { resolve(''); }
        });
      }).on('error', () => resolve('')).on('timeout', function () { this.destroy(); resolve(''); });
  });
}

// Free offers on YouTube: fixed searches plus "<new model> 무료/free".
async function youtubePromos(names, days) {
  const queries = ['AI 무료 프로모션', 'AI 무료 기간 한정', 'free AI model limited time',
    ...names.map((n) => `${n} 무료`)];
  const candidates = new Map();
  for (const q of queries) {
    // Space requests out; back-to-back searches get empty pages.
    await new Promise((res) => setTimeout(res, 1200));
    const videos = await youtube(q, days).catch(() => []);
    for (const v of videos) {
      const text = `${v.title} ${v.snippet}`;
      if (candidates.has(v.id) || SPAM.test(text) || !aboutAI(text, names)) continue;
      candidates.set(v.id, v);
    }
  }

  const FREE = /(무료|공짜|free|크레딧|credit)/i;
  const PROMO_LINE = /[^.!?\n]*(무료|free|프로모션|promotion|이벤트|event|까지|until|through)[^.!?\n]*/i;
  const out = [];
  let lookups = 0;
  for (const v of candidates.values()) {
    let text = `${v.title} ${v.snippet}`;
    let deadline = deadlineIn(text, v.date);
    // Read the full description of likely offers (free in title, or a watched model in title) to find the end date.
    const watched = names.some((n) => v.title.toLowerCase().includes(n.toLowerCase()));
    if (!deadline && (FREE.test(v.title) || watched) && lookups < 30) {
      lookups++;
      await new Promise((res) => setTimeout(res, 400));
      const desc = await videoDescription(v.id);
      const freeLines = desc.split(/\n/).filter((l) => FREE.test(l) || /프로모션|promotion|이벤트/i.test(l)).join('\n');
      const found = deadlineIn(freeLines, v.date);
      if (found) {
        deadline = found;
        text = `${v.title} ${freeLines}`;
      }
    }
    if (!FREE.test(text)) continue;
    // Without a deadline, keep only videos whose title itself is about free use.
    if (!deadline && !FREE.test(v.title)) continue;
    const sentence = (text.slice(v.title.length).match(PROMO_LINE) || [''])[0].trim();
    out.push({
      kind: 'news', source: `YouTube · ${v.channel || ''}`, lang: /[가-힣]/.test(v.title) ? 'ko' : 'en', video: true,
      id: `yt:${v.id}`, name: v.title, summary: sentence.slice(0, 200),
      url: `https://www.youtube.com/watch?v=${v.id}`,
      date: v.date.toISOString(),
      deadline: deadline ? deadline.toISOString().slice(0, 10) : null,
      daysLeft: daysUntil(deadline),
    });
  }
  return out;
}

// ---------- Recently released models, to search for model-specific free promos ----------

function modelNames(vercelAll, openRouterAll, days) {
  const since = Date.now() - days * 86400000;
  const names = [];
  const add = (name, when) => {
    if (!name || when < since) return;
    // "Jev", "Ling 3.0 Flash Fin (Free)" -> "Jev", "Ling 3.0"
    const base = name.replace(/\s*\((free|preview)\)|\s+free$/ig, '').split(/\s+/).slice(0, 2).join(' ').replace(/:.*$/, '').trim();
    if (base.length >= 3 && !names.some((n) => n.toLowerCase() === base.toLowerCase())) names.push(base);
  };
  for (const m of vercelAll) if (m.type === 'language' || m.type === 'evaluation') add(m.name, (m.released || m.created) * 1000);
  for (const m of openRouterAll) add((m.name || '').replace(/^[^:]+:\s*/, ''), m.created * 1000);
  return names.slice(0, 20);
}

// ---------- Vercel AI Gateway: free language models ----------

let vercelRaw = [];
let openRouterRaw = [];

async function vercelGateway() {
  const data = await get('https://ai-gateway.vercel.sh/v1/models', true);
  vercelRaw = data.data || [];
  return vercelRaw
    .filter((m) => m.type === 'language' && m.pricing && m.pricing.input === '0' && m.pricing.output === '0')
    .map((m) => ({
      kind: 'model',
      gateway: 'vercel',
      id: m.id,
      name: `${m.name} · Vercel`,
      description: (m.description || '').replace(/\s+/g, ' ').slice(0, 400),
      context: m.context_window,
      created: (m.released || m.created) * 1000,
      expires: null,
      daysLeft: null,
      url: `https://vercel.com/ai-gateway/models/${m.id.split('/').pop()}`,
    }));
}

// ---------- A single page the user adds by URL (Threads post, blog, announcement) ----------

async function readLink(url) {
  // Link-preview crawlers get server-rendered text on sites such as Threads that otherwise need a login.
  const html = await new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'facebookexternalhit/1.1' }, timeout: 20000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return readLink(new URL(res.headers.location, url).href).then(resolve, reject);
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body));
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('시간 초과')); });
  });
  if (typeof html === 'object') return html;
  const meta = (prop) => {
    const m = html.match(new RegExp(`<meta[^>]+(?:property|name)="${prop}"[^>]+content="([^"]*)"`, 'i'))
      || html.match(new RegExp(`<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="${prop}"`, 'i'));
    return m ? decodeXml(m[1].replace(/&#x([0-9a-f]+);/gi, (_, x) => String.fromCodePoint(parseInt(x, 16)))
      .replace(/&#(\d+);/g, (_, x) => String.fromCodePoint(+x))) : '';
  };
  const title = meta('og:title') || decodeXml((html.match(/<title>([^<]*)<\/title>/i) || [])[1]) || url;
  const text = meta('og:description') || meta('description');
  const deadline = deadlineIn(`${title} ${text}`);
  return {
    kind: 'custom', id: `custom:${url}`, source: title.trim(),
    name: (text.split(/\n/).find((l) => l.trim()) || title).trim().slice(0, 80), text: text.trim(), url,
    deadline: deadline ? deadline.toISOString().slice(0, 10) : null,
    addedAt: new Date().toISOString(),
  };
}

async function collect(extraFeeds) {
  const errors = [];
  const safe = (p, name, fallback) => p.catch((e) => { errors.push(`${name}: ${e.message}`); return fallback; });
  const [orModels, vcModels, dir, hn, feeds] = await Promise.all([
    safe(openRouter(), 'OpenRouter', []),
    safe(vercelGateway(), 'Vercel AI Gateway', []),
    safe(directory(), 'Free-LLM 목록', { permanent: [], renewable: [], trial: [] }),
    safe(news(30), 'Hacker News', []),
    safe(vendorFeeds(60, extraFeeds), '공식 변경 기록', []),
  ]);
  // Models released in the last three weeks: their promos often appear only in news and videos.
  const names = modelNames(vercelRaw, openRouterRaw, 21);
  const [promos, videos] = await Promise.all([
    safe(promoNews(14, names), 'Google 뉴스', []),
    safe(youtubePromos(names, 14), 'YouTube', []),
  ]);
  return { models: [...orModels, ...vcModels], ...dir, news: hn, promos: [...feeds, ...promos, ...videos],
    watched: names, errors, fetchedAt: Date.now() };
}

module.exports = { collect, readLink, deadlineIn, daysUntil, DIRECTORY_PAGE };
