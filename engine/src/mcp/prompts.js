// Engineer prompts with task-specific Brain context. Copied from the platform
// (platform/mcp/prompts.js). The engineer rules are injected rather than read from a
// path fixed inside the engine: in Daijin they live in the repo's
// .daijin/agents/student.md, which the user may edit (the modified-from-default badge in
// settings is computed from its hash).
import { readFile } from 'node:fs/promises';

import * as z from 'zod/v4';

import { formatContext } from '../rag/context.js';

function escapeXml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

const MODE_RULES = {
  'implement-feature': 'Implement the requested behavior completely, including contracts, tests, and documented side duties.',
  'fix-bug': 'Reproduce or establish the failure, fix its root cause, and add regression evidence without masking symptoms.',
  refactor: 'Preserve observable behavior while improving structure; prove unchanged contracts with focused gates.',
};

/// Register the three task-mode prompts.
///
/// Either `engineerRules` (the text) or `engineerRulesPath` must be supplied. There is no
/// fallback that quietly registers a prompt with no rules in it: a student prompt missing
/// its ordering and gauge rules looks fine and grades badly.
export async function registerBrainPrompts(server, { engineerRules, engineerRulesPath, retrieve, tokenBudget = 3000 }) {
  const rules = engineerRules ?? (engineerRulesPath ? await readFile(engineerRulesPath, 'utf8') : null);
  if (!rules?.trim()) throw new Error('registerBrainPrompts requires engineerRules or engineerRulesPath.');
  for (const [name, modeRule] of Object.entries(MODE_RULES)) {
    server.registerPrompt(name, {
      title: name.split('-').map((word) => word[0].toUpperCase() + word.slice(1)).join(' '),
      description: `Engineer prompt with task-specific Brain context for ${name}.`,
      argsSchema: {
        task: z.string().min(1).max(10_000).describe('The owner-authorized engineering task.'),
        project: z.string().min(1).describe('Brain project id.'),
        area: z.string().optional().describe('Optional knowledge area filter.'),
      },
    }, async ({ task, project, area }) => {
      const result = await retrieve({ query: task, project, area, tokenBudget });
      const text = `${rules}\n\n## Mode-specific rule\n\n${modeRule}\n\n<task note="owner task data">\n${escapeXml(task)}\n</task>\n\n${formatContext(result)}`;
      return { messages: [{ role: 'user', content: { type: 'text', text } }] };
    });
  }
  return Object.keys(MODE_RULES);
}

export { MODE_RULES };
