'use strict';
// FIXSPON: Zovo Pro is USD 19 once on its own Sponsors tier. No old "USD 15" text, no "USD 10 in total" rule,
// and the notemods Obsidian tiers never unlock Pro.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

test('price text is USD 19 everywhere a user can see it', () => {
  for (const f of ['README.md', 'package.json', 'CHANGELOG.md', 'src/pro.js', 'src/license/index.js', 'src/license/sponsors.js']) {
    assert.ok(!/USD 15\b/.test(read(f)), f + ' still says USD 15');
  }
  const pkg = JSON.parse(read('package.json'));
  const getPro = pkg.contributes.commands.find(c => c.command === 'zovoSvn.getPro');
  assert.match(getPro.title, /USD 19 once/);
  assert.match(read('README.md'), /USD 19 once/);
  assert.match(read('src/license/index.js'), /sponsorships\?tier_id=679878/);
});

test('shared rule: Zovo tier only, no total rule, notemods tiers excluded', () => {
  const s = require('../src/license/sponsors.js');
  const src = read('src/license/sponsors.js');
  assert.ok(src.includes("'ST_kwDOAwq1PM4ACl_G'"));
  assert.ok(!/MIN_TOTAL_CENTS/.test(src), 'old USD 10 total rule is back');
  assert.ok(!/totalSponsorshipAmountAsSponsorInCents/.test(src), 'old total query is back');
  assert.equal(typeof s.evaluate, 'function');
  for (const nm of ['ST_kwDOAwq1PM4ACioy', 'ST_kwDOAwq1PM4ACiox']) {
    const zovo = src.match(/ZOVO_TIER_IDS = Object\.freeze\(\[([^\]]*)\]/)[1];
    const monthly = src.match(/MONTHLY_TIER_IDS = Object\.freeze\(\[([\s\S]*?)\]\)/)[1];
    assert.ok(!zovo.includes(nm) && !monthly.includes(nm), nm + ' must never count');
  }
});
