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
      // THE REALM TRAP, detected rather than left to archaeology: a zai key
      // answering 429 on the pay-as-you-go realm is, in every case seen so
      // far, a Coding Plan key aimed at the wrong billing realm.
      const realmTrap = role.provider === 'zai'
        && ping.httpStatus === 429
        && effective === zaiDefault;
      rows.push(finding({
        id: `role-failed:${role.role}`,
        at,
        severity: 'warn',
        category: 'roles',
        target: role.role,
        summary: `The ${role.role} role's last verification failed`,
        detail: realmTrap
          ? `${ping.hint || ''} Z.ai bills its two realms separately: this key may be `
            + 'subscribed on the GLM Coding Plan realm (api/coding/paas/v4) rather than '
            + 'pay-as-you-go (api/paas/v4).'
          : ping.hint || `HTTP ${ping.httpStatus ?? 'none'}.`,
        fixId: realmTrap ? 'zai-coding-endpoint' : null,
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
