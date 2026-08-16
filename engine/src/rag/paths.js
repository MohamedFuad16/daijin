// Module path grammar and reverse impact.
//
// The platform hard codes one repository's directory shapes into a regex
// (rag/query.js:1) and two translation functions. The extraction report classifies that
// as STRUCTURAL (section 1d): the `mod:` namespace idea is sound and reusable, the
// specific directory names are not. So the grammar is data here, read from one place by
// both the graph builder and the query rewriter.
//
// A grammar is:
//   { mappings: [{ repo, node, display }], suffixRules: [{ suffix, node }] }
// `mappings` is ORDERED; the first matching prefix wins. `display: true` marks the
// mapping used to render a node back as a repo path (several repo prefixes may fold
// onto one node namespace, only one folds back).

export const PLATFORM_PATH_GRAMMAR = Object.freeze({
  mappings: [
    { repo: 'editor/src/', node: 'mod:web/src/', display: true },
    { repo: 'editor/server/', node: 'mod:web/server/', display: true },
    { repo: 'src/', node: 'mod:web/src/', display: false },
    { repo: 'server/', node: 'mod:web/server/', display: false },
    { repo: 'InternshipPortal/', node: 'mod:ios/', display: true },
  ],
  suffixRules: [{ suffix: '.swift', node: 'mod:ios/' }],
  pattern: /(?:mod:[a-z-]+\/[A-Za-z0-9_./@+-]+|(?:editor\/)?(?:src|server)\/[A-Za-z0-9_./@+-]+\.(?:js|jsx|ts|tsx|css)|(?:InternshipPortal\/)?[A-Za-z0-9_./@+-]+\.swift)/g,
});

/// A grammar for a repository with no declared roots: `mod:` nodes pass through, and a
/// source path is recognised by extension. Used until init measures a repo's real shape.
export const GENERIC_PATH_GRAMMAR = Object.freeze({
  mappings: [],
  suffixRules: [],
  pattern: /(?:mod:[a-z-]+\/[A-Za-z0-9_./@+-]+|[A-Za-z0-9_./@+-]+\.(?:js|jsx|ts|tsx|css|py|rb|go|rs|java|kt|swift))/g,
});

export function normalizeModulePath(raw, grammar = PLATFORM_PATH_GRAMMAR) {
  const value = raw.replace(/^[`'"(]+|[`'"),:;]+$/g, '').replace(/^\.\//, '');
  if (value.startsWith('mod:')) return value;
  for (const mapping of grammar.mappings) {
    if (value.startsWith(mapping.repo)) return `${mapping.node}${value.slice(mapping.repo.length)}`;
  }
  for (const rule of grammar.suffixRules) {
    if (value.endsWith(rule.suffix)) return `${rule.node}${value}`;
  }
  return value;
}

export function displayModulePath(node, grammar = PLATFORM_PATH_GRAMMAR) {
  for (const mapping of grammar.mappings) {
    if (mapping.display && node.startsWith(mapping.node)) {
      return `${mapping.repo}${node.slice(mapping.node.length)}`;
    }
  }
  return node.replace(/^mod:/, '');
}

export function extractModuleNodes(query, availableNodes = [], grammar = PLATFORM_PATH_GRAMMAR) {
  const available = new Set(availableNodes);
  const matches = query.match(grammar.pattern) || [];
  const resolved = [];
  for (const match of matches) {
    const normalized = normalizeModulePath(match, grammar);
    if (available.has(normalized)) resolved.push(normalized);
    else {
      const suffix = normalized.replace(/^mod:[^/]+\//, '');
      const candidates = availableNodes.filter((node) => node.endsWith(`/${suffix}`));
      if (candidates.length === 1) resolved.push(candidates[0]);
    }
  }
  return [...new Set(resolved)];
}

/// Walk reverse import edges from every module the query names: what breaks if this
/// changes. Depth ordered, then path ordered, so identical input gives identical output.
export function reverseImpact(query, relationships, maxDepth = 12, grammar = PLATFORM_PATH_GRAMMAR) {
  const imports = relationships.filter((edge) => edge.kind === 'imports');
  const available = [...new Set(imports.flatMap((edge) => [edge.src, edge.dst]))];
  const roots = extractModuleNodes(query, available, grammar);
  const reverse = new Map();
  for (const edge of imports) {
    const sources = reverse.get(edge.dst) || [];
    sources.push(edge.src);
    reverse.set(edge.dst, sources);
  }
  const impacts = new Map();
  for (const root of roots) {
    const queue = [{ node: root, depth: 0 }];
    const visited = new Set([root]);
    while (queue.length > 0) {
      const current = queue.shift();
      if (current.depth >= maxDepth) continue;
      for (const source of reverse.get(current.node) || []) {
        if (visited.has(source)) continue;
        visited.add(source);
        const depth = current.depth + 1;
        const prior = impacts.get(source);
        if (!prior || depth < prior.depth) impacts.set(source, { node: source, depth, root });
        queue.push({ node: source, depth });
      }
    }
  }
  return [...impacts.values()]
    .map((item) => ({
      ...item,
      path: displayModulePath(item.node, grammar),
      rootPath: displayModulePath(item.root, grammar),
    }))
    .sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));
}
