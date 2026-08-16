#!/usr/bin/env node
// The P8 integration fixture: one small, boring, deterministic repo.
//
//   node engine/test-live/p8-fixture.mjs /path/to/fixture-repo
//
// Built because the integration acceptance needs a repo BOTH claimants point at, and
// "point daijin at something" produced an eight-second analyze timeout on /tmp when
// tui-builder tried it. This one is bounded: a dozen small files and a short commit
// history, which is enough for the gold-set miner to have commit archaeology, structural
// self-reference and identifier cases to work with, and small enough that init finishes
// while someone is watching.
//
// DETERMINISTIC ON PURPOSE. Fixed file contents, fixed commit messages, fixed author and
// fixed dates, so two people running the acceptance on two machines are looking at the same
// repo. Dates are pinned because a gold set mined from commit archaeology would otherwise
// vary with the day it was built, and a fixture that drifts makes two runs incomparable
// for a reason unrelated to what is being demonstrated.
//
// It writes ONLY into the directory it is given, and refuses a directory that already has
// content, because a fixture builder that can overwrite a real repository is one typo away
// from being a data-loss tool.

import { execFileSync } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const FILES = {
  'package.json': JSON.stringify({
    name: 'orderly', version: '0.1.0', type: 'module',
    scripts: { test: 'node --test test/', lint: 'echo lint', build: 'echo build' },
    dependencies: { 'better-sqlite3': '^11.0.0' },
  }, null, 2),

  'README.md': [
    '# Orderly',
    '',
    'A small order service. Orders arrive on the queue, are priced, and are written to the',
    'ledger. The pricing rules live in one module on purpose: they change often and every',
    'change needs a review.',
  ].join('\n'),

  'src/api/orders.js': [
    "import { priceOrder } from '../pricing/rules.js';",
    "import { writeOrder } from '../storage/ledger.js';",
    '',
    '/** Accept one order, price it, and record it. */',
    'export async function submitOrder(order) {',
    '  const priced = priceOrder(order);',
    '  return writeOrder(priced);',
    '}',
  ].join('\n'),

  'src/api/health.js': [
    "import { ledgerReady } from '../storage/ledger.js';",
    '',
    'export async function health() {',
    '  return { ok: await ledgerReady() };',
    '}',
  ].join('\n'),

  'src/pricing/rules.js': [
    '// Pricing rules. Every rule here is a decision someone made deliberately.',
    '',
    'export const BULK_THRESHOLD = 24;',
    'export const BULK_DISCOUNT = 0.1;',
    '',
    '/** Price one order. Bulk orders take a discount; nothing else does. */',
    'export function priceOrder(order) {',
    '  const subtotal = order.lines.reduce((total, line) => total + line.unitPrice * line.quantity, 0);',
    '  const quantity = order.lines.reduce((total, line) => total + line.quantity, 0);',
    '  const discount = quantity >= BULK_THRESHOLD ? subtotal * BULK_DISCOUNT : 0;',
    '  return { ...order, subtotal, discount, total: subtotal - discount };',
    '}',
  ].join('\n'),

  'src/pricing/tax.js': [
    "import { priceOrder } from './rules.js';",
    '',
    '/** Tax is applied AFTER the discount, which is the rule the finance review settled. */',
    'export function pricedWithTax(order, rate) {',
    '  const priced = priceOrder(order);',
    '  return { ...priced, tax: priced.total * rate };',
    '}',
  ].join('\n'),

  'src/storage/ledger.js': [
    'const rows = [];',
    '',
    'export async function writeOrder(order) {',
    '  rows.push(order);',
    '  return order;',
    '}',
    '',
    'export async function ledgerReady() {',
    '  return true;',
    '}',
    '',
    'export function allOrders() {',
    '  return [...rows];',
    '}',
  ].join('\n'),

  'src/queue/consumer.js': [
    "import { submitOrder } from '../api/orders.js';",
    '',
    'export async function consume(messages) {',
    '  const accepted = [];',
    '  for (const message of messages) accepted.push(await submitOrder(message.body));',
    '  return accepted;',
    '}',
  ].join('\n'),

  'test/pricing.test.js': [
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    '',
    "import { priceOrder } from '../src/pricing/rules.js';",
    '',
    "test('a bulk order takes the discount', () => {",
    '  const priced = priceOrder({ lines: [{ unitPrice: 10, quantity: 30 }] });',
    '  assert.equal(priced.discount, 30);',
    '});',
  ].join('\n'),

  'docs/decisions.md': [
    '# Decisions',
    '',
    '## Pricing rules live in one module',
    '',
    'They change often and every change needs a review, so they are kept together rather',
    'than spread across the call sites that use them.',
    '',
    '## Tax is applied after the discount',
    '',
    'Settled by the finance review. Applying it before the discount overcharges bulk orders.',
  ].join('\n'),

  '.gitignore': 'node_modules/\n.daijin/\n',
};

// Commits with real subjects, including two fixes, so errors.md has something to mine and
// the gold set has commit archaeology rather than only structural self-reference.
const COMMITS = [
  ['src/pricing/rules.js', 'fix: bulk discount was applied per line instead of per order'],
  ['src/pricing/tax.js', 'fix: tax was computed before the discount, overcharging bulk orders'],
  ['src/api/orders.js', 'refactor: submitOrder prices before writing'],
  ['src/queue/consumer.js', 'feat: consume a batch of queued orders'],
  ['src/storage/ledger.js', 'chore: expose allOrders for the health check'],
];

const GIT_ENVIRONMENT = {
  GIT_AUTHOR_NAME: 'Fixture Author', GIT_AUTHOR_EMAIL: 'author@example.test',
  GIT_COMMITTER_NAME: 'Fixture Author', GIT_COMMITTER_EMAIL: 'author@example.test',
};

export async function buildFixture(root) {
  // Refuse a directory with anything in it. A fixture builder that can overwrite a real
  // repository is one typo away from being a data-loss tool.
  await mkdir(root, { recursive: true });
  const existing = await readdir(root);
  if (existing.length > 0) {
    throw new Error(`${root} is not empty (${existing.length} entries). Point this at a new directory; it will not write over anything.`);
  }

  for (const [file, content] of Object.entries(FILES)) {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${content}\n`, 'utf8');
  }

  const git = (args, environment = {}) => execFileSync('git', ['-C', root, ...args], {
    env: { ...process.env, ...GIT_ENVIRONMENT, ...environment },
    stdio: 'pipe',
  });
  git(['init', '-b', 'main']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['add', '-A']);
  git(['commit', '-m', 'initial import of the orderly service'], {
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  });

  let day = 2;
  for (const [file, subject] of COMMITS) {
    await writeFile(path.join(root, file), `\n// touched: ${subject}\n`, { flag: 'a' });
    git(['add', '-A']);
    const date = `2026-01-${String(day).padStart(2, '0')}T00:00:00Z`;
    git(['commit', '-m', subject], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    day += 1;
  }

  return { root, files: Object.keys(FILES).length, commits: COMMITS.length + 1 };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: node engine/test-live/p8-fixture.mjs /path/to/new/fixture-repo');
    process.exitCode = 1;
  } else {
    buildFixture(path.resolve(target))
      .then((result) => console.log(`fixture built at ${result.root}: ${result.files} files, ${result.commits} commits`))
      .catch((error) => { console.error(error.message); process.exitCode = 1; });
  }
}
