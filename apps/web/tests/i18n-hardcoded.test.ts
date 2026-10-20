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
  /** trecho exato do texto permitido */
  text: string;
  reason: string;
}
const ALLOWED: Allowed[] = [
  { file: "components/TerminalPanel.tsx", text: "senha", reason: "valor enviado pela API (elevation), não texto de interface" },
  { file: "components/TerminalPanel.tsx", text: "sim", reason: "valor enviado pela API (hostDockerAccess), não texto de interface" },
  { file: "lib/terminal-info.ts", text: "senha", reason: "valor enviado pela API (elevation) e modo PAAS_ROOT_MODE=senha" },
  { file: "components/backups/backup-ui.tsx", text: "painel", reason: "palavra de confirmação que o servidor exige em português (backup-service confirmText)" },
  { file: "lib/auth.tsx", text: "useAuth deve ser usado dentro do RequireAuth", reason: "erro de programação (desenvolvedor), nunca chega ao usuário" },
  { file: "pages/setup/SecurityStep.tsx", text: "operador não conseguiu entrar", reason: "casa uma linha do log do executor, escrita em português no pacote security" },
  { file: "pages/setup/SetupDone.tsx", text: "recomeçar", reason: "palavra de confirmação que o servidor compara (setup-restart)" },
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

function literalsOf(file: string): string[] {
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isLiteralTypeNode(node)) return;
    if (ts.isJsxAttribute(node) && /^(className|data-testid|href|to|type|role|key|id|name|htmlFor)$/.test(node.name.getText())) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) found.push(node.text);
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) found.push(node.text);
    else if (ts.isJsxText(node)) found.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

export function findHardcoded(): string[] {
  const out: string[] = [];
  for (const file of files(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join("/");
    for (const text of literalsOf(file)) {
      if (!looksPortuguese(text)) continue;
      if (ALLOWED.some((a) => a.file === rel && text.trim() === a.text)) continue;
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
      const used = literalsOf(path.join(SRC, a.file)).some((t) => t.trim() === a.text);
      expect(used, `exceção sem uso: ${a.file}: ${a.text}`).toBe(true);
    }
  });
});
