// Remark plugin: turns GitHub alerts (`> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`,
// `> [!WARNING]`, `> [!CAUTION]`) into Starlight asides at build time, leaving
// the Markdown untouched so it keeps rendering as alerts on GitHub.
//
// It rewrites the blockquote into a `containerDirective` node, which Starlight's
// own aside plugin then renders. This plugin must therefore run before it
// (user remark plugins do).

const TYPES = {
  NOTE: { aside: 'note', title: { en: 'Note', 'pt-br': 'Nota' } },
  TIP: { aside: 'tip', title: { en: 'Tip', 'pt-br': 'Dica' } },
  IMPORTANT: { aside: 'note', title: { en: 'Important', 'pt-br': 'Importante' } },
  WARNING: { aside: 'caution', title: { en: 'Warning', 'pt-br': 'Aviso' } },
  CAUTION: { aside: 'danger', title: { en: 'Caution', 'pt-br': 'Cuidado' } },
};

const MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\r?\n)?/i;

function transform(node, locale) {
  if (!Array.isArray(node.children)) return;
  for (const child of node.children) transform(child, locale);

  if (node.type !== 'blockquote' || !node.children.length) return;
  const first = node.children[0];
  if (first.type !== 'paragraph' || !first.children.length) return;
  const text = first.children[0];
  if (text.type !== 'text') return;
  const m = MARKER.exec(text.value);
  if (!m) return;

  const info = TYPES[m[1].toUpperCase()];
  text.value = text.value.slice(m[0].length);
  if (text.value === '') first.children.shift();
  if (!first.children.length) node.children.shift();

  const title = info.title[locale] ?? info.title.en;
  const label = {
    type: 'paragraph',
    data: { directiveLabel: true },
    children: [{ type: 'text', value: title }],
  };
  node.type = 'containerDirective';
  node.name = info.aside;
  node.attributes = {};
  node.children = [label, ...node.children];
}

export default function remarkGithubAlerts() {
  return (tree, file) => {
    const p = (file.path ?? '').split('\\').join('/');
    const m = /\/content\/docs\/([^/]+)\//.exec(p);
    transform(tree, m ? m[1] : 'en');
  };
}
