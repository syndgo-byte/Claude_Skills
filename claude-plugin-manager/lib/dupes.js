'use strict';
// Finds the same plugin installed more than once (same name from different marketplaces).

function analyze(plugins) {
  const byName = new Map();
  for (const p of plugins) {
    if (!byName.has(p.name)) byName.set(p.name, []);
    byName.get(p.name).push(p);
  }
  const groups = [];
  const redundant = [];
  for (const list of byName.values()) {
    if (list.length < 2) continue;
    groups.push(list.map((p) => p.id));
    // Keep one copy on: the first enabled one, preferring the official marketplace.
    const sorted = list.slice().sort((a, b) => (b.enabled - a.enabled)
      || ((b.marketplace === 'claude-plugins-official') - (a.marketplace === 'claude-plugins-official')));
    redundant.push(...sorted.slice(1).filter((p) => p.enabled).map((p) => p.id));
  }
  return { groups, redundant, byItem: new Map() };
}

module.exports = { analyze };
