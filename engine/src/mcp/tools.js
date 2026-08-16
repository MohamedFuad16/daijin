// MCP tool surface. Copied from the platform (platform/mcp/tools.js); the only change is
// that the type enum reads from rag/types.js instead of repeating the eight strings.
import * as z from 'zod/v4';

import { formatContext } from '../rag/context.js';
import { ALLOWED_TYPES } from '../rag/types.js';

const TYPES = z.enum([...ALLOWED_TYPES]);
const retrievalOutput = {
  context: z.string(),
  retrievedIds: z.array(z.string()),
  impactCount: z.number().int().nonnegative(),
};

function retrievalToolResult(result) {
  const structuredContent = {
    context: formatContext(result),
    retrievedIds: result.meta.retrievedIds,
    impactCount: result.impact.length,
  };
  return { content: [{ type: 'text', text: structuredContent.context }], structuredContent };
}

export function registerBrainTools(server, { retrieve, writeEvaluation }) {
  server.registerTool('brain.search', {
    title: 'Search the AI Brain',
    description: 'Hybrid semantic and structural search over current non-draft Brain knowledge.',
    inputSchema: {
      query: z.string().min(1).max(10_000),
      project: z.string().min(1),
      types: z.array(TYPES).optional(),
      area: z.string().optional(),
      k: z.number().int().min(1).max(50).optional(),
      tokenBudget: z.number().int().min(128).max(100_000).optional(),
    },
    outputSchema: retrievalOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => retrievalToolResult(await retrieve(input)));

  server.registerTool('brain.conventions', {
    title: 'Get Brain conventions',
    description: 'Retrieve current conventions, principles, and workflows for a project area.',
    inputSchema: { project: z.string().min(1), area: z.string().min(1) },
    outputSchema: retrievalOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ project, area }) => retrievalToolResult(await retrieve({
    query: `current conventions and engineering principles for ${area}`,
    project,
    area,
    types: ['convention', 'principle', 'workflow'],
  })));

  server.registerTool('brain.impact_of', {
    title: 'Get dependency impact',
    description: 'Walk reverse module-import edges for a source file path.',
    inputSchema: { project: z.string().min(1), path: z.string().min(1).max(1_000) },
    outputSchema: {
      context: z.string(),
      retrievedIds: z.array(z.string()),
      impact: z.array(z.object({
        node: z.string(), path: z.string(), depth: z.number().int(), root: z.string(), rootPath: z.string(),
      })),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ project, path }) => {
    const result = await retrieve({ query: `what depends on ${path}`, project });
    const structuredContent = {
      context: formatContext(result),
      retrievedIds: result.meta.retrievedIds,
      impact: result.impact,
    };
    return { content: [{ type: 'text', text: structuredContent.context }], structuredContent };
  });

  server.registerTool('brain.relevant_adrs', {
    title: 'Get relevant current ADRs',
    description: 'Retrieve current decisions for a topic and note their superseded ancestors.',
    inputSchema: { project: z.string().min(1), topic: z.string().min(1).max(10_000) },
    outputSchema: retrievalOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ project, topic }) => retrievalToolResult(await retrieve({ query: topic, project, types: ['decision'] })));

  server.registerTool('brain.record_evaluation', {
    title: 'Record a draft evaluation',
    description: 'Write a quarantined DRAFT evaluation. Only the human curation gate may promote it.',
    inputSchema: {
      project: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
      task: z.string().min(1).max(20_000),
      summary: z.string().min(1).max(20_000),
      verdict: z.enum(['pass', 'partial', 'fail']),
      surface: z.string().max(200).optional(),
      evidence: z.array(z.string().max(2_000)).max(100).optional(),
      retrievedIds: z.array(z.string().max(500)).max(500).optional(),
      metrics: z.record(z.string(), z.unknown()).optional(),
    },
    outputSchema: { id: z.string(), status: z.literal('draft'), path: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input) => {
    const structuredContent = await writeEvaluation(input);
    return {
      content: [{ type: 'text', text: `Draft evaluation recorded at ${structuredContent.path}; human curation is required.` }],
      structuredContent,
    };
  });
}
