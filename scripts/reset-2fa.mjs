// reset-2fa.mjs — desliga a verificação em duas etapas de todas as contas do
// painel, direto no users.json. Chamado por scripts/reset-2fa.sh (com o painel
// PARADO, para ele não regravar o arquivo com o estado antigo da memória).
// Não toca em usuário, senha, sessões nem em mais nada.
//
// Uso: node reset-2fa.mjs /data/users.json
import { readFileSync, writeFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("uso: node reset-2fa.mjs <caminho do users.json>");
  process.exit(2);
}

const data = JSON.parse(readFileSync(file, "utf8"));
const users = Array.isArray(data.users) ? data.users : [];
const affected = users.filter((u) => u && u.twoFactor);
if (affected.length === 0) {
  console.log("Nenhuma conta está com a verificação em duas etapas ativa — nada a fazer.");
  process.exit(0);
}
const now = new Date().toISOString();
data.users = users.map((u) => (u && u.twoFactor ? { ...u, twoFactor: null, updatedAt: now } : u));
writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
for (const u of affected) {
  console.log(`Verificação em duas etapas desligada para: ${u.username}`);
}
