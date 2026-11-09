'use strict';
// Pro switch: shipped off. Every feature runs, no label shows, the license commands only say that all is free.
const test = require('node:test');
const assert = require('node:assert/strict');
const mock = require('./helpers/vscode');
const { createPro, PRO_ENABLED, PRO_FEATURES } = require('../src/pro');

test('PRO_ENABLED is false: all free, no labels, license commands answer "free"', async () => {
  assert.equal(PRO_ENABLED, false);
  const { vscode, state } = mock.create();
  const ctx = mock.context(require('os').tmpdir());
  const pro = createPro({ vscode, context: ctx });
  for (const f of PRO_FEATURES) for (let i = 0; i < 10; i++) assert.equal(await pro.allow(f, ''), true);
  assert.deepEqual(pro.labels(), []);
  assert.equal(state.contexts['zovoSvn.proEnabled'], false);
  await vscode.commands.executeCommand('zovoSvn.unlockWithSponsors');
  assert.match(state.messages.pop()[1], /free in this version/);
});

test('switched on: 3 free tries per feature, then the license decides', async () => {
  const { vscode } = mock.create();
  const ctx = mock.context(require('os').tmpdir());
  let asked = 0;
  const license = { ready: Promise.resolve(), isPro: () => false, requirePro: async () => { asked++; return false; } };
  const pro = createPro({ vscode, context: ctx, enabled: true, license });
  for (let i = 0; i < 3; i++) assert.equal(await pro.allow('Shelving', ''), true);
  assert.equal(await pro.allow('Shelving', ''), false);
  assert.equal(asked, 1);
  assert.deepEqual(pro.labels(), PRO_FEATURES);
  const paid = createPro({ vscode: mock.create().vscode, context: mock.context(require('os').tmpdir()), enabled: true, license: { ready: Promise.resolve(), isPro: () => true, requirePro: async () => false } });
  assert.equal(await paid.allow('Revision graph', ''), true);
});
