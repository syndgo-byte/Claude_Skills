'use strict';
// Korean text for free-AI offers, translated on this PC and cached to disk.
// Shares ~/.claude/plugin-manager-ko.json with the claude-plugin-manager extension (same flat
// key -> Korean string format, no id collisions) so the two never translate the same text twice.
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

const USER_FILE = path.join(os.homedir(), '.claude', 'plugin-manager-ko.json');

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
  return userDict[key];
}

function save() {
  fs.mkdirSync(path.dirname(USER_FILE), { recursive: true });
  fs.writeFileSync(USER_FILE, JSON.stringify(userDict, null, 2) + '\n', 'utf8');
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
  return data.map((d) => (Array.isArray(d) ? d[0] : d));
}

// Fallback: MyMemory (anonymous, 500 characters per request).
async function myMemory(text) {
  const body = await httpGet(`https://api.mymemory.translated.net/get?langpair=en|ko&q=${encodeURIComponent(text.slice(0, 480))}`);
  const data = JSON.parse(body);
  if (data.responseStatus !== 200) throw new Error(data.responseDetails || 'MyMemory 오류');
  return data.responseData.translatedText;
}

let running = null;
const attempted = new Set();

// Translates entries with free web translators (no Claude tokens) and caches them on disk.
function translate(entries) {
  running = (running || Promise.resolve()).then(() => translateNow(entries)).catch(() => 0);
  return running;
}

async function translateNow(entries) {
  load();
  // Each key is tried once per session; saving the file retriggers other watchers, so failures must not loop.
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
  }
  return done;
}

module.exports = { USER_FILE, load, lookup, translate };
