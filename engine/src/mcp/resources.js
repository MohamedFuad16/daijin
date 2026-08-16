// Brain files as read-only MCP resources. Copied from the platform
// (platform/mcp/resources.js); the one change is that the skipped directory list is a
// parameter rather than a literal `exams`, because which subtrees are answers rather
// than knowledge is per repo.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const EXTENSIONS = new Set(['.md', '.json', '.yaml', '.yml']);

// `exams` is the platform's default exclusion and stays the default here: an exam
// directory holds the answers the student must not see, and exposing it over MCP would
// leak the gold set into the run being measured.
export const DEFAULT_SKIPPED_DIRECTORIES = ['exams'];

async function walk(directory, skipped) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory() && !skipped.includes(entry.name)) files.push(...await walk(absolute, skipped));
    else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) files.push(absolute);
  }
  return files;
}

function mimeType(file) {
  if (file.endsWith('.md')) return 'text/markdown';
  if (file.endsWith('.json')) return 'application/json';
  return 'application/yaml';
}

function resourceUri(relative) {
  return `ai-brain:///${relative.split(path.sep).map(encodeURIComponent).join('/')}`;
}

export async function discoverBrainResources(brainRoot, skipped = DEFAULT_SKIPPED_DIRECTORIES) {
  return (await walk(brainRoot, skipped)).map((file) => {
    const relative = path.relative(brainRoot, file);
    return { file, relative, uri: resourceUri(relative), mimeType: mimeType(file) };
  });
}

export async function registerBrainResources(server, brainRoot, skipped = DEFAULT_SKIPPED_DIRECTORIES) {
  const resources = await discoverBrainResources(brainRoot, skipped);
  server.registerResource('ai-brain-tree', 'ai-brain://', {
    title: 'AI Brain tree',
    description: 'Read-only index of canonical Brain resources.',
    mimeType: 'application/json',
  }, async () => ({
    contents: [{
      uri: 'ai-brain://',
      mimeType: 'application/json',
      text: JSON.stringify(resources.map(({ relative, uri, mimeType: type }) => ({ path: relative, uri, mimeType: type })), null, 2),
    }],
  }));
  for (const resource of resources) {
    server.registerResource(`brain:${resource.relative}`, resource.uri, {
      title: resource.relative,
      description: 'Read-only canonical AI Brain file.',
      mimeType: resource.mimeType,
    }, async () => ({
      contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: await readFile(resource.file, 'utf8') }],
    }));
  }
  return resources;
}
