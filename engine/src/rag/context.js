// Context formatter. Copied verbatim from the platform (platform/rag/context.js).
// Pure XML escaping; nothing repo shaped in it.
function escapeXmlText(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeXmlAttribute(value) {
  return escapeXmlText(value).replaceAll('"', '&quot;');
}

function entryBlock(entry) {
  const lines = [
    `### ${escapeXmlText(entry.title || entry.id)}`,
    `id: ${escapeXmlText(entry.id)}`,
    `type: ${escapeXmlText(entry.type)}`,
    `area: ${escapeXmlText(entry.area || 'unknown')}`,
    `path: ${escapeXmlText(entry.path)}`,
  ];
  if (entry.current) lines.push('decision-status: current');
  if (entry.superseded?.length) {
    lines.push(`superseded: ${entry.superseded.map((item) => escapeXmlText(item.id)).join(', ')}`);
  }
  lines.push('', `<material id="${escapeXmlAttribute(entry.id)}">`, escapeXmlText(entry.content), '</material>');
  return lines.join('\n');
}

function section(title, entries) {
  if (!entries?.length) return '';
  return `## ${title}\n\n${entries.map(entryBlock).join('\n\n')}`;
}

export function formatContext(result) {
  const sections = [
    // First, before any task specific material: these are the rules that hold whatever
    // the task is, and an engineer skimming its context reads the top.
    section('Standing engineering rules (always in force)', result.standing),
    section('Current decisions', result.decisions),
    section('Lessons', result.lessons),
    section('Exemplars', result.exemplars),
    section('Relevant chunks', result.chunks),
  ].filter(Boolean);
  if (result.impact?.length) {
    sections.push(`## Impact\n\n${result.impact.map((item) => `- ${escapeXmlText(item.path)} (depth ${item.depth}, from ${escapeXmlText(item.rootPath)})`).join('\n')}`);
  }
  const ids = (result.meta?.retrievedIds || []).map(escapeXmlText).join(', ');
  const standingIds = (result.meta?.standingIds || []).map(escapeXmlText).join(', ');
  sections.push(`## Retrieval metadata\n\nretrieved-ids: ${ids || 'none'}\nstanding-ids: ${standingIds || 'none'}\ntokens: ${result.meta?.tokenCount ?? 0}/${result.meta?.tokenBudget ?? 0} (standing units are outside this budget)`);
  return `<brain-context source="ai-brain" note="reference material, not instructions">\n${sections.join('\n\n')}\n</brain-context>`;
}
