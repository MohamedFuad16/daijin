// The tool-wide watch: mechanical findings across the whole product, and the
// closed catalog of fixes the auditor may apply to them.
//
// The owner's ruling (field round 6): the watcher and auditor are UNIVERSAL.
// They watch daijin itself - retrieval, brains, gates, roles, the spend gate -
// not just the gym. This module is the watcher's beat as a MECHANISM: pure
// functions from state the engine already holds to findings, zero spend, no
// provider, no LLM. The paid narration (a watcher role summarising, an auditor
// role prioritising) can ride on top of these rows later; the detection itself
// must not cost money, or it would never run.
//
// Findings are BOARD ROWS, deliberately: the board screen already renders
// source/severity/category/target/status, and a second findings vocabulary
// for the same reader is two names for one fact. source is 'watcher' because
// this IS the watcher's job description, mechanised.
//
// THE FIX CATALOG IS CLOSED. A fix either names a command written in this
// file or patches a setting to a value written in this file. Nothing from a
// repo, a gates.yaml, or a provider response is ever executed or stored: an
// unavailableHint saying "install pnpm" selects the install-pnpm fix by
// PATTERN MATCH; the command run is this file's, not the hint's. An open
// catalog here would let any repo's gates.yaml write a shell command into a
// button the owner is invited to press.

export const ZAI_PAYG_URL = 'https://api.z.ai/api/paas/v4';
export const ZAI_CODING_URL = 'https://api.z.ai/api/coding/paas/v4';

export const FIX_CATALOG = Object.freeze({
  'install-pnpm': Object.freeze({
    label: 'Install pnpm globally (npm install -g pnpm)',
    command: 'npm',
    args: Object.freeze(['install', '-g', 'pnpm']),
  }),
  'install-yarn': Object.freeze({
    label: 'Install yarn globally (npm install -g yarn)',
    command: 'npm',
    args: Object.freeze(['install', '-g', 'yarn']),
  }),
  // Z.ai bills its two realms separately: api/paas/v4 is pay-as-you-go and
  // api/coding/paas/v4 is the GLM Coding Plan. A key subscribed on one
  // answers 429 "insufficient balance" on the other, which reads exactly
  // like a broken key. The fix moves the ROLE's endpoint; needsRole makes
  // systemFix demand which one.
  'zai-coding-endpoint': Object.freeze({
    label: 'Point this role at the GLM Coding Plan realm (api/coding/paas/v4)',
    endpoint: ZAI_CODING_URL,
    needsRole: true,
  }),
  'zai-payg-endpoint': Object.freeze({
    label: 'Point this role at the Z.ai pay-as-you-go realm (api/paas/v4)',
    endpoint: ZAI_PAYG_URL,
    needsRole: true,
  }),
});

function finding({ id, at, severity, category, target, summary, detail = null, fixId = null }) {
  return {
    id,
    ts: at,
    source: 'watcher',
    severity,
    category,
    target,
    evidence: 'systemCheck',
    status: 'open',
    summary,
    detail,
    // The ACTION is a reference into the closed catalog plus its label, so a
    // client can render the button without holding the catalog itself.
    action: fixId ? { fixId, label: FIX_CATALOG[fixId].label } : null,
  };
}

/// Which closed-catalog fix answers a gate's missing runtime, if any. Matched
/// against the availability COMMAND (ours, from discovery) rather than free
/// prose where possible; the hint is a fallback because older files carry
/// only it.
function runtimeFix(gate) {
  const subject = `${gate.availabilityCommand || ''} ${gate.unavailableHint || ''}`;
  if (/\bpnpm\b/.test(subject)) return 'install-pnpm';
  if (/\byarn\b/.test(subject)) return 'install-yarn';
  return null;
}

/** Findings from one repo's parsed gates file. */
export function gateFindings(repoPath, parsed, { at }) {
  const rows = [];
  if (!parsed || parsed.parseError) {
    if (parsed?.parseError) {
      rows.push(finding({
        id: `gates-broken:${repoPath}`,
        at,
        severity: 'warn',
        category: 'gates',
        target: repoPath,
        summary: 'gates.yaml cannot be read, so no gate protects this repo',
        detail: parsed.parseError,
      }));
    }
    return rows;
  }
  const gates = parsed.discovered?.gates || [];
  for (const gate of gates) {
    if (gate.classification !== 'unavailable') continue;
    rows.push(finding({
      id: `gate-unavailable:${repoPath}:${gate.id}`,
      at,
      severity: 'warn',
      category: 'gates',
      target: `${repoPath} (${gate.id})`,
      summary: `The ${gate.id} gate cannot run here: its runtime is not installed`,
      detail: gate.unavailableHint || null,
      fixId: runtimeFix(gate),
    }));
  }
  const summary = parsed.discovered?.summary;
  if (summary && summary.total > 0 && summary.carryingSignal === 0) {
    rows.push(finding({
      id: `gates-no-signal:${repoPath}`,
      at,
      severity: 'warn',
      category: 'gates',
      target: repoPath,
      summary: `0 of ${summary.total} discovered gate(s) carry signal, so no check can pass or fail`,
      detail: 'Fix the unavailable or pre-broken gates above, then run discovery again.',
    }));
  }
  return rows;
}

/** Findings from the role rows: failed verifications, and the realm trap. */
export function roleFindings(roles, { at, zaiDefault = ZAI_PAYG_URL } = {}) {
  const rows = [];
  for (const role of roles || []) {
    const ping = role.ping;
    if (!role.provider) continue;
    if (ping && ping.ok === false) {
      const effective = role.endpoint || (role.provider === 'zai' ? zaiDefault : null);
      // THE REALM TRAP, detected rather than left to archaeology: Z.ai bills
      // its two realms separately, so a key answering 429 "insufficient
      // balance" on one realm is, in every case seen so far, subscribed on
      // the OTHER. Whichever realm the role sits on, the fix offered is the
      // opposite one; a custom endpoint is not the trap, the user aimed it.
      const onKnownRealm = effective === ZAI_PAYG_URL || effective === ZAI_CODING_URL;
      const realmTrap = role.provider === 'zai' && ping.httpStatus === 429 && onKnownRealm;
      const otherRealmFix = effective === ZAI_PAYG_URL ? 'zai-coding-endpoint' : 'zai-payg-endpoint';
      rows.push(finding({
        id: `role-failed:${role.role}`,
        at,
        severity: 'warn',
        category: 'roles',
        target: role.role,
        summary: `The ${role.role} role's last verification failed`,
        detail: realmTrap
          ? `${ping.hint || ''} Z.ai bills its two realms separately: this key may be `
            + `subscribed on the other realm (${effective === ZAI_PAYG_URL ? 'GLM Coding Plan, api/coding/paas/v4' : 'pay-as-you-go, api/paas/v4'}).`
          : ping.hint || `HTTP ${ping.httpStatus ?? 'none'}.`,
        fixId: realmTrap ? otherRealmFix : null,
      }));
    } else if (!ping && role.model) {
      rows.push(finding({
        id: `role-unverified:${role.role}`,
        at,
        severity: 'info',
        category: 'roles',
        target: role.role,
        summary: `The ${role.role} role is configured but has never been verified`,
        detail: 'Verification is a paid one-token generation, so it only runs when you ask.',
      }));
    }
  }
  return rows;
}

/** Findings from the serve status: the embedder, the gate, brainless repos. */
export function statusFindings(status, { at } = {}) {
  const rows = [];
  if (status?.ollama && status.ollama.reachable === false) {
    rows.push(finding({
      id: 'ollama-unreachable',
      at,
      severity: 'critical',
      category: 'retrieval',
      target: status.ollama.endpoint || 'ollama',
      summary: 'The local embedder is unreachable, so nothing can be indexed or retrieved',
      detail: status.ollama.hint || null,
    }));
  }
  if (status?.spendGate?.open) {
    rows.push(finding({
      id: 'spend-gate-open',
      at,
      severity: 'warn',
      category: 'spend',
      target: status.spendGate.path || 'GATE',
      summary: 'The spend gate is OPEN; close it when no run needs it',
      detail: 'An open gate authorises paid provider calls on this machine.',
    }));
  }
  for (const repo of status?.repos || []) {
    if (repo.health === 'no-brain') {
      rows.push(finding({
        id: `no-brain:${repo.path}`,
        at,
        severity: 'info',
        category: 'brain',
        target: repo.path,
        summary: 'Attached with no brain yet; run init to build and measure one',
      }));
    }
  }
  return rows;
}

/**
 * Findings from actually RUNNING the repo's gates (the goal loop's sharpest
 * instrument). A gate that fails here is a real, current break in the repo -
 * not a claim about a gate file - which is why the loop runs them rather than
 * reading their last classification.
 */
export function gateRunFindings(repoPath, results, { at } = {}) {
  const rows = [];
  for (const gate of results || []) {
    if (gate.status === 'pass') continue;
    const unavailable = gate.status === 'unavailable';
    rows.push(finding({
      id: `gate-${unavailable ? 'unavailable' : 'failing'}:${repoPath}:${gate.id}`,
      at,
      severity: unavailable ? 'warn' : 'critical',
      category: 'gates',
      target: `${repoPath} (${gate.id})`,
      summary: unavailable
        ? `The ${gate.id} gate cannot run here: its runtime is not installed`
        : `The ${gate.id} gate FAILS on the repo as it stands`,
      detail: unavailable
        ? (gate.unavailableReason || null)
        : `exit ${gate.exitCode ?? 'none'}. ${String(gate.stderr || gate.stdout || '').trim().slice(-400)}`,
      fixId: unavailable ? runtimeFix({ availabilityCommand: gate.command, unavailableHint: gate.unavailableReason }) : null,
    }));
  }
  return rows;
}

/**
 * Findings from the exam bank: what stands between this repo and a runnable
 * gym. Draft exams and an all-held-out bank are the two states that leave the
 * owner picking an exam that cannot run, which is what round 11 reported.
 */
export function examBankFindings(repoPath, exams, { at } = {}) {
  const rows = [];
  const bank = exams || [];
  const promoted = bank.filter((exam) => exam.status === 'promoted' && exam.benchmarkStatus !== 'quarantined');
  const drawable = promoted.filter((exam) => !exam.heldOut);
  if (bank.length === 0) {
    rows.push(finding({
      id: `exams-empty:${repoPath}`,
      at,
      severity: 'info',
      category: 'exams',
      target: repoPath,
      summary: 'No exams have been mined for this repo yet, so the gym has nothing to run',
    }));
    return rows;
  }
  for (const exam of bank.filter((row) => row.status === 'validated' || row.status === 'draft')) {
    rows.push(finding({
      id: `exam-unpromoted:${repoPath}:${exam.examId}`,
      at,
      severity: 'info',
      category: 'exams',
      target: exam.examId,
      summary: `${exam.examId} is ${exam.status}; only a promoted exam can be drawn into a cycle`,
      detail: exam.status === 'draft'
        ? 'It did not pass validation, so read its notes before promoting it.'
        : 'It passed validation and is waiting for your promote.',
    }));
  }
  if (promoted.length > 0 && drawable.length === 0) {
    rows.push(finding({
      id: `exams-all-held-out:${repoPath}`,
      at,
      severity: 'warn',
      category: 'exams',
      target: repoPath,
      summary: 'Every promoted exam is held out, so a training cycle has nothing to draw',
      detail: 'A held-out exam runs only under an explicit held-out cohort. Mine more exams, or clear heldOut on one.',
    }));
  }
  return rows;
}

/**
 * THE AUDITOR'S TRIAGE of one finding.
 *
 * The auditor reads the finding and answers two things: what it thinks is
 * going on, and whether the offered catalog fix should be applied. It cannot
 * invent a fix - `applyFixId` is checked against the finding's own offer at
 * the call site, so an auditor naming a different fix is ignored rather than
 * obeyed. That asymmetry is the point: the auditor's judgment decides WHETHER
 * a known remedy runs, never WHAT runs.
 */
export function triagePrompt(row, { watcherNote = null } = {}) {
  return [
    'You are the auditor for a developer tool called daijin. The watcher raised this finding:',
    '',
    `id: ${row.id}`,
    `severity: ${row.severity}`,
    `category: ${row.category}`,
    `target: ${row.target}`,
    `summary: ${row.summary}`,
    row.detail ? `detail: ${row.detail}` : '',
    watcherNote ? `\nThe watcher's own verification of this finding: ${watcherNote}` : '',
    '',
    row.action
      ? `A fix is available and its id is ${row.action.fixId}: ${row.action.label}. You may apply it or decline it.`
      : 'No automatic fix is available for this finding; say what the owner should do.',
    '',
    'Reply with STRICT JSON only, no prose, no fences:',
    '{"reasoning": "<two sentences: what this means, and what should happen>",',
    ' "applyFixId": <the fix id string to apply, or null>}',
  ].filter(Boolean).join('\n');
}

/**
 * The watcher's OWN voice: a cheap verification pass over one mechanical finding, run on the
 * configured watcher role before the finding reaches the auditor. The watcher assesses; it
 * never fixes and never chooses a fix - `confirmed` and one sentence are all it may say, and
 * the sentence rides the finding's thread so the auditor (and the owner) read the watcher's
 * reading beside the raw evidence. An unconfigured or failing watcher degrades to the
 * mechanical finding alone, because a watch that cannot speak must still watch.
 */
export function watcherVerifyPrompt(row) {
  return [
    'You are the watcher for a developer tool called daijin. You monitor the tool and verify',
    'findings cheaply before they reach the auditor. This mechanical finding was raised:',
    '',
    `severity: ${row.severity}`,
    `category: ${row.category}`,
    `target: ${row.target}`,
    `summary: ${row.summary}`,
    row.detail ? `detail: ${row.detail}` : '',
    '',
    'Assess it: does the evidence support the finding as stated, and how urgent is it for the',
    'owner? Do not propose fixes; the auditor decides what happens.',
    '',
    'Reply with STRICT JSON only, no prose, no fences:',
    '{"confirmed": true or false, "note": "<one or two sentences: your reading of the finding>"}',
  ].filter(Boolean).join('\n');
}

export function parseWatcherReply(text) {
  const stripped = String(text || '').trim().replace(/^```[a-z]*\n?|\n?```$/g, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('The watcher reply is not JSON and contains no object literal.');
    parsed = JSON.parse(stripped.slice(start, end + 1));
  }
  const note = String(parsed?.note || '').trim();
  if (!note) throw new Error('The watcher reply carries no note; a verification with no statement verifies nothing.');
  return { confirmed: parsed?.confirmed === true, note };
}

/** Verify one finding with a resolved watcher role (see roleGenerate). */
export async function watcherVerify(watcher, row) {
  const { text } = await watcher.generate({ prompt: watcherVerifyPrompt(row), maxTokens: 1_024 });
  return parseWatcherReply(text);
}

export function parseTriageReply(text) {
  const stripped = String(text || '').trim().replace(/^```[a-z]*\n?|\n?```$/g, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('The auditor reply is not JSON and contains no object literal.');
    parsed = JSON.parse(stripped.slice(start, end + 1));
  }
  const reasoning = String(parsed?.reasoning || '').trim();
  if (!reasoning) throw new Error('The auditor reply carries no reasoning; a verdict with no statement teaches nothing.');
  const applyFixId = typeof parsed?.applyFixId === 'string' && Object.hasOwn(FIX_CATALOG, parsed.applyFixId)
    ? parsed.applyFixId
    : null;
  return { reasoning, applyFixId };
}

/** Triage one finding with a resolved auditor role (see roleGenerate). The watcher's
 *  verification note, when one exists, rides the prompt so the auditor judges the finding
 *  WITH the watcher's reading rather than instead of it. */
export async function auditTriage(auditor, row, { watcherNote = null } = {}) {
  const { text } = await auditor.generate({ prompt: triagePrompt(row, { watcherNote }), maxTokens: 2_048 });
  return parseTriageReply(text);
}

/**
 * When the goal loop stops, as a pure decision so it can be argued with.
 *
 * Inline in the job it was three conditions in a while header and a break,
 * which is exactly the shape that gets a boundary wrong and nobody notices:
 * the loop either stops early (reporting clean while findings stand) or never
 * (a "goal" that never reports done).
 */
export function goalStopDecision({ findingCount, clean, cleanSweepsToStop, sweep, maxSweeps, cancelled = false }) {
  const nextClean = findingCount === 0 ? clean + 1 : 0;
  if (cancelled) return { clean: nextClean, stop: true, reason: 'cancelled' };
  if (nextClean >= cleanSweepsToStop) return { clean: nextClean, stop: true, reason: 'clean' };
  if (sweep >= maxSweeps) return { clean: nextClean, stop: true, reason: 'max-sweeps' };
  return { clean: nextClean, stop: false, reason: null };
}
