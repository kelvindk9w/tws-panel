// reativar-acesso-ip.mjs — volta a ligar o acesso ao painel pelo endereço do
// IP (<ip-com-hífens>.sslip.io), direto no panel-domain.json do volume de
// dados. Chamado por scripts/reativar-acesso-ip.sh com o painel PARADO (ele
// guarda o estado em memória e regravaria o arquivo antigo).
//
// Mantém o domínio próprio cadastrado: o painel volta a responder nos dois
// endereços. Arquivo ilegível vira "nenhum domínio" (o painel volta só pelo
// IP) — nunca deixa o painel sem endereço.
//
// Uso: node reativar-acesso-ip.mjs /data/panel-domain.json
import { readFileSync, renameSync, writeFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("uso: node reativar-acesso-ip.mjs <caminho do panel-domain.json>");
  process.exit(2);
}

function save(data) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, file);
}

let raw;
try {
  raw = readFileSync(file, "utf8");
} catch {
  console.log("O acesso pelo IP já está ativo (nenhum domínio do painel configurado) — nada a fazer.");
  process.exit(0);
}

let data;
try {
  data = JSON.parse(raw);
} catch {
  save({ domain: null, active: false, ipAccessDisabled: false, lastCheck: null, updatedAt: new Date().toISOString() });
  console.log("Arquivo do domínio do painel ilegível: trocado por um sem domínio. O painel volta a abrir só pelo endereço do IP.");
  process.exit(0);
}

if (!data || data.ipAccessDisabled !== true) {
  console.log("O acesso pelo IP já está ativo — nada a fazer no arquivo.");
  process.exit(0);
}

save({ ...data, ipAccessDisabled: false, updatedAt: new Date().toISOString() });
console.log(`Acesso pelo IP reativado. O domínio ${data.domain ?? "(nenhum)"} continua cadastrado.`);
