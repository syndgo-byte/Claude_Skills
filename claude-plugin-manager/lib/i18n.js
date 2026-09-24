'use strict';
// Korean descriptions: bundled dictionary plus translations generated on this PC.
const https = require('https');
const fs = require('fs');
const path = require('path');
const { CLAUDE_DIR } = require('./store');

const USER_FILE = path.join(CLAUDE_DIR, 'plugin-manager-ko.json');
const BUNDLED = require('./ko.json');

const HOOK_EVENTS = {
  SessionStart: '세션 시작 시',
  SessionEnd: '세션 종료 시',
  UserPromptSubmit: '메시지를 보낼 때마다',
  PreToolUse: '도구 실행 직전',
  PostToolUse: '도구 실행 직후',
  Stop: '응답이 끝날 때',
  SubagentStop: '하위 에이전트가 끝날 때',
  PreCompact: '대화 압축 직전',
  Notification: '알림이 뜰 때',
};

let userDict = {};

function load() {
  try {
    userDict = JSON.parse(fs.readFileSync(USER_FILE, 'utf8').replace(/^﻿/, ''));
  } catch {
    userDict = {};
  }
}
load();

function lookup(key) {
  return userDict[key] || BUNDLED[key];
}

function pluginKey(p) {
  return `plugin:${p.name}`;
}

function compKey(p, kind, name) {
  return `${p.name}/${kind}/${name}`;
}

function hookEvent(name) {
  return HOOK_EVENTS[name];
}

// Every description on the given plugins that has no Korean text yet.
function missing(plugins) {
  const out = {};
  for (const p of plugins) {
    if (p.description && !lookup(pluginKey(p))) out[pluginKey(p)] = p.description;
    for (const kind of ['skills', 'commands', 'agents']) {
      for (const x of p.components[kind]) {
        const key = compKey(p, kind, x.name);
        if (x.description && !lookup(key)) out[key] = x.description.replace(/\s+/g, ' ').slice(0, 600);
      }
    }
  }
  return out;
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 20000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => (res.statusCode === 200 ? resolve(body) : reject(new Error(`HTTP ${res.statusCode}`))));
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('번역 요청 시간 초과')); });
  });
}

// Free Google endpoint used by the Chrome dictionary extension; accepts several q values per call.
async function googleBatch(texts) {
  const qs = texts.map((t) => `q=${encodeURIComponent(t)}`).join('&');
  const body = await httpGet(`https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=ko&${qs}`);
  const data = JSON.parse(body);
  // One text returns ["..."], several return ["...", "..."]; some responses nest [text, lang].
  return data.map((d) => (Array.isArray(d) ? d[0] : d));
}

// Fallback: MyMemory (anonymous, 500 characters per request).
async function myMemory(text) {
  const body = await httpGet(`https://api.mymemory.translated.net/get?langpair=en|ko&q=${encodeURIComponent(text.slice(0, 480))}`);
  const data = JSON.parse(body);
  if (data.responseStatus !== 200) throw new Error(data.responseDetails || 'MyMemory 오류');
  return data.responseData.translatedText;
}

function save() {
  fs.writeFileSync(USER_FILE, JSON.stringify(userDict, null, 2) + '\n', 'utf8');
}

let running = null;
const attempted = new Set();

// Translates entries with free web translators (no Claude tokens) and caches them on disk.
function translate(entries, onProgress) {
  // Serialize runs so two refreshes do not translate the same keys twice.
  running = (running || Promise.resolve()).then(() => translateNow(entries, onProgress)).catch(() => 0);
  return running;
}

async function translateNow(entries, onProgress) {
  load();
  // Each key is tried once per session; saving the file retriggers the watcher, so failures must not loop.
  const keys = Object.keys(entries).filter((k) => !lookup(k) && !attempted.has(k));
  keys.forEach((k) => attempted.add(k));
  let done = 0;
  const batches = [];
  let cur = [];
  let len = 0;
  for (const k of keys) {
    const size = encodeURIComponent(entries[k]).length;
    if (cur.length && (len + size > 5000 || cur.length >= 25)) { batches.push(cur); cur = []; len = 0; }
    cur.push(k);
    len += size;
  }
  if (cur.length) batches.push(cur);

  for (const batch of batches) {
    let results = [];
    try {
      results = await googleBatch(batch.map((k) => entries[k]));
    } catch {
      results = [];
    }
    let changed = 0;
    for (let i = 0; i < batch.length; i++) {
      let ko = typeof results[i] === 'string' ? results[i].trim() : '';
      if (!ko) {
        try { ko = (await myMemory(entries[batch[i]])).trim(); } catch { ko = ''; }
      }
      if (ko) { userDict[batch[i]] = ko; changed++; }
    }
    if (changed) save();
    done += changed;
    if (onProgress) onProgress(done, keys.length);
  }
  return done;
}

module.exports = { USER_FILE, load, lookup, pluginKey, compKey, hookEvent, missing, translate };
