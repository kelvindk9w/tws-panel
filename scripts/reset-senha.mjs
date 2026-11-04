// reset-senha.mjs — redefine SÓ a senha do painel, direto no users.json do
// volume de dados. Chamado por scripts/reset-senha.sh com o painel PARADO (ele
// guarda os usuários em memória e regravaria o arquivo antigo).
//
// A senha nova chega pela ENTRADA PADRÃO (uma linha), nunca por argumento nem
// variável de ambiente: assim não aparece em `ps`, `docker inspect` nem em log.
//
// Mantém conta, 2FA, projetos e tudo o mais. Como a troca de senha pelo painel,
// derruba TODAS as sessões (sessions.json) e revoga os tokens de API
// (api-tokens.json), ambos na mesma pasta do users.json.
//
// Uso: printf '%s\n' "$SENHA" | node reset-senha.mjs /data/users.json [--usuario NOME]
import { closeSync, existsSync, fchownSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const args = process.argv.slice(2);
const file = args[0];
let wanted = null;
if (args[1] === "--usuario") wanted = args[2] ?? "";
if (!file || (args.length > 1 && (args[1] !== "--usuario" || !wanted || args.length > 3))) {
  console.error("uso: node reset-senha.mjs <caminho do users.json> [--usuario NOME]  (senha nova na entrada padrão)");
  process.exit(2);
}

// Mesmas regras de passwordStrengthErrors (packages/core/src/auth.ts).
function strengthErrors(p) {
  const e = [];
  if (p.length < 12) e.push("mínimo de 12 caracteres");
  if (!/[A-Z]/.test(p)) e.push("ao menos uma letra maiúscula");
  if (!/[a-z]/.test(p)) e.push("ao menos uma letra minúscula");
  if (!/[0-9]/.test(p)) e.push("ao menos um número");
  return e;
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// Gravação atômica: temporário na mesma pasta + rename, mesmo dono e 0600.
function saveAtomic(target, text) {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`);
  const original = statSync(target);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    try { fchownSync(fd, original.uid, original.gid); } catch {}
    writeSync(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, target);
  } catch (err) {
    try { closeSync(fd); } catch {}
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
}

const password = readStdin().replace(/\r?\n$/, "");
const errors = strengthErrors(password);
if (errors.length > 0) {
  console.error(`Senha fraca: ${errors.join(", ")}.`);
  process.exit(3);
}

const data = JSON.parse(readFileSync(file, "utf8"));
const users = Array.isArray(data.users) ? data.users : [];
let target;
if (wanted) {
  target = users.find((u) => u && typeof u.usernameLower === "string" && u.usernameLower === wanted.toLowerCase());
  if (!target) {
    console.error(`Usuário "${wanted}" não encontrado no painel.`);
    process.exit(4);
  }
} else {
  if (users.length !== 1) {
    console.error(users.length === 0 ? "O painel ainda não tem conta de administrador." : "Há mais de uma conta: informe --usuario NOME.");
    process.exit(4);
  }
  target = users[0];
}

// O mesmo argon2id do painel (@node-rs/argon2 mora em apps/server).
const appDir = process.env.PAAS_APP_DIR || "/app";
const req = createRequire(path.join(appDir, "apps/server/package.json"));
const { hash } = req("@node-rs/argon2");
const passwordHash = await hash(password);

const now = new Date().toISOString();
data.users = users.map((u) => (u === target ? { ...u, passwordHash, updatedAt: now } : u));
saveAtomic(file, JSON.stringify(data, null, 2) + "\n");

const dir = path.dirname(file);
const sessionsFile = path.join(dir, "sessions.json");
if (existsSync(sessionsFile)) saveAtomic(sessionsFile, JSON.stringify({ sessions: [] }, null, 2) + "\n");

let revoked = 0;
const tokensFile = path.join(dir, "api-tokens.json");
if (existsSync(tokensFile)) {
  try {
    const t = JSON.parse(readFileSync(tokensFile, "utf8"));
    if (Array.isArray(t.tokens)) {
      t.tokens = t.tokens.map((x) => {
        if (x && x.revokedAt === null) {
          revoked += 1;
          return { ...x, revokedAt: now };
        }
        return x;
      });
      if (revoked > 0) saveAtomic(tokensFile, JSON.stringify(t, null, 2) + "\n");
    }
  } catch {
    console.error("Aviso: api-tokens.json ilegível; revogue os tokens em Configurações → Acesso por IA.");
  }
}
console.log(`Senha do painel redefinida para: ${target.username}. Sessões encerradas; ${revoked} token(s) de API revogado(s). 2FA e demais dados mantidos.`);
