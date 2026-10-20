import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Detector de texto fixo em português fora dos dicionários.
 *
 * Varre os componentes e libs de `src/` (menos `locales/` e `i18n/`) com o
 * parser do TypeScript e reprova qualquer texto visível (literal de string,
 * template, texto JSX) que pareça português: letra acentuada, palavra
 * funcional ("para", "não", "uma"...) ou rótulo comum de interface ("Salvar").
 * É uma heurística: pega o que escapa na migração; não prova que não falta nada.
 *
 * Texto que PRECISA ficar em português (casamento com mensagem do servidor,
 * exemplo literal, nome de arquivo...) entra em ALLOWED, com o motivo.
 */
const SRC = path.resolve(__dirname, "../src");
const SKIP_DIRS = new Set(["locales", "i18n"]);

interface Allowed {
  file: string;
  /** texto exato do literal permitido */
  text: string;
  /** trecho da LINHA do código onde ele pode aparecer: a exceção vale só ali, não no arquivo todo */
  line: string;
  reason: string;
}
const ALLOWED: Allowed[] = [
  { file: "components/TerminalPanel.tsx", text: "senha", line: 'elevation === "senha"', reason: "valor enviado pela API (elevation), não texto de interface" },
  { file: "components/TerminalPanel.tsx", text: "senha", line: 'case "senha":', reason: "valor enviado pela API (elevation), não texto de interface" },
  { file: "components/TerminalPanel.tsx", text: "sim", line: 'dockerAccess === "sim"', reason: "valor enviado pela API (hostDockerAccess), não texto de interface" },
  { file: "components/TerminalPanel.tsx", text: "sim", line: 'data-urgente={urgente ? "sim" : "nao"}', reason: "atributo de estado para teste/estilo, não aparece na tela" },
  { file: "lib/terminal-info.ts", text: "senha", line: "const ELEVATIONS", reason: "valor enviado pela API (elevation), não texto de interface" },
  { file: "lib/terminal-info.ts", text: "senha", line: 'info.elevation === "senha"', reason: "valor enviado pela API (elevation), não texto de interface" },
  { file: "components/backups/backup-ui.tsx", text: "painel", line: 'target.kind === "panel" ? "painel"', reason: "palavra de confirmação que o servidor exige em português (backup-service confirmText)" },
  { file: "lib/auth.tsx", text: "useAuth deve ser usado dentro do RequireAuth", line: "throw new Error", reason: "erro de programação (desenvolvedor), nunca chega ao usuário" },
  { file: "pages/setup/SecurityStep.tsx", text: "operador não conseguiu entrar", line: "finished.log.includes", reason: "casa uma linha do log do executor, escrita em português no pacote security" },
  { file: "pages/setup/SetupDone.tsx", text: "recomeçar", line: "const CONFIRMATION", reason: "palavra de confirmação que o servidor compara (routes/setup-restart.ts)" },
];

const ACCENT = /[áàâãäéèêíìîóòôõöúùûüçñ]/i;
const FUNCTION_WORDS = new Set([
  "de", "do", "da", "dos", "das", "para", "com", "uma", "que", "seu", "sua", "seus", "suas", "ou", "por", "foi",
  "ao", "nos", "nas", "ainda", "mais", "sem", "está", "são", "pelo", "pela", "mesmo", "isso", "este", "esta",
  "aqui", "quando", "depois", "antes", "tente", "veja", "não",
]);
const UI_WORDS = new Set([
  "salvar", "cancelar", "voltar", "fechar", "excluir", "remover", "senha", "projeto", "projetos", "carregando",
  "copiar", "copiado", "atualizar", "continuar", "sim", "ativar", "desativar", "abrir", "criar", "editar",
  "adicionar", "enviar", "baixar", "testar", "conectar", "verificar", "entrar", "sair", "usuário", "falha",
  "erro", "sucesso", "ativo", "inativo", "nenhum", "nenhuma", "pronto", "concluído", "aguardando", "restaurar",
  "domínio", "certificado", "servidor", "configurações", "painel", "caixa", "pasta", "arquivo", "tentar",
]);

export function looksPortuguese(raw: string): boolean {
  const text = raw.trim();
  if (!/[a-zà-ú]/i.test(text)) return false;
  if (ACCENT.test(text)) return true;
  const tokens = text
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/^[^a-zà-ú]+|[^a-zà-ú]+$/g, ""))
    .filter(Boolean);
  if (tokens.some((w) => UI_WORDS.has(w))) return true;
  return tokens.length >= 2 && tokens.some((w) => FUNCTION_WORDS.has(w));
}

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return SKIP_DIRS.has(e.name) ? [] : files(p);
    return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
}

function literalsOf(file: string): Array<{ text: string; line: string }> {
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const found: Array<{ text: string; line: string }> = [];
  const push = (node: ts.Node, text: string) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart());
    found.push({ text, line: source.text.split("\n")[line] ?? "" });
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isLiteralTypeNode(node)) return;
    if (ts.isJsxAttribute(node) && /^(className|data-testid|href|to|type|role|key|id|name|htmlFor)$/.test(node.name.getText())) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) push(node, node.text);
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) push(node, node.text);
    else if (ts.isJsxText(node)) push(node, node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

export function findHardcoded(): string[] {
  const out: string[] = [];
  for (const file of files(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join("/");
    for (const { text, line } of literalsOf(file)) {
      if (!looksPortuguese(text)) continue;
      if (ALLOWED.some((a) => a.file === rel && text.trim() === a.text && line.includes(a.line))) continue;
      out.push(`${rel}: ${text.trim().replace(/\s+/g, " ").slice(0, 100)}`);
    }
  }
  return out;
}

describe("texto fixo em português fora dos dicionários", () => {
  it("o detector reconhece português e deixa inglês/identificadores passarem", () => {
    for (const s of ["Salvar", "Não foi possível salvar", "Configuração", "Tente novamente para continuar", "Falha ao carregar"]) {
      expect(looksPortuguese(s), s).toBe(true);
    }
    for (const s of ["Save", "Could not save the project", "flex items-center", "/api/projects", "example.com", "pt-BR", "", "  ", "·", "GET"]) {
      expect(looksPortuguese(s), s).toBe(false);
    }
  });

  it("nenhum componente ou lib tem texto português fixo", () => {
    expect(findHardcoded()).toEqual([]);
  });

  it("a lista de exceções tem motivo e ainda é usada", () => {
    for (const a of ALLOWED) {
      expect(a.reason.length).toBeGreaterThan(10);
      const used = literalsOf(path.join(SRC, a.file)).some((l) => l.text.trim() === a.text && l.line.includes(a.line));
      expect(used, `exceção sem uso: ${a.file}: ${a.text}`).toBe(true);
    }
  });
});
