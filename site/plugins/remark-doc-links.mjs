// Remark plugin: lets the Markdown sources link to each other with plain
// relative paths (`../guides/operations.md#anchor`), which also work when the
// files are browsed on GitHub. At build time those links are rewritten to the
// URL Starlight serves (`<base>/<locale>/guides/operations/#anchor`).
//
// Links to anything else (http(s), `#anchor`, absolute paths, non-.md files)
// are left untouched.

import path from 'node:path';

const DOCS_MARKER = `${path.sep}content${path.sep}docs${path.sep}`;

function walk(node, fn) {
  fn(node);
  if (Array.isArray(node.children)) for (const child of node.children) walk(child, fn);
}

export default function remarkDocLinks(options = {}) {
  const base = (options.base ?? '').replace(/\/$/, '');

  return (tree, file) => {
    const filePath = file.path ?? '';
    const idx = filePath.indexOf(DOCS_MARKER);
    if (idx === -1) return;
    const rel = filePath.slice(idx + DOCS_MARKER.length).split(path.sep).join('/');
    const dir = path.posix.dirname(rel);

    walk(tree, (node) => {
      if (node.type !== 'link' || typeof node.url !== 'string') return;
      const url = node.url;
      if (/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(url)) return;

      const hashAt = url.indexOf('#');
      const target = hashAt === -1 ? url : url.slice(0, hashAt);
      const hash = hashAt === -1 ? '' : url.slice(hashAt);
      if (!target.endsWith('.md') && !target.endsWith('.mdx')) return;

      const resolved = path.posix.normalize(path.posix.join(dir, target));
      if (resolved.startsWith('..')) return;
      let slug = resolved.replace(/\.mdx?$/, '');
      slug = slug.replace(/\/index$/, '').replace(/^index$/, '');
      node.url = `${base}/${slug}${slug ? '/' : ''}${hash}`;
    });
  };
}
