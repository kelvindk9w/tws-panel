// reset-2fa.mjs — desliga a verificação em duas etapas de todas as contas do
// painel, direto no users.json. Chamado por scripts/reset-2fa.sh (com o painel
// PARADO, para ele não regravar o arquivo com o estado antigo da memória).
// Não toca em usuário, senha, sessões nem em mais nada.
// Desligar o 2FA também apaga o bloqueio por excesso de códigos errados (ele
// mora dentro do registro do 2FA). Com --so-bloqueio o 2FA CONTINUA ligado e
// só o bloqueio é limpo (para quem tem o celular, mas foi trancado por erros).
//
// Ao desligar o 2FA (e NÃO no --so-bloqueio) o "código por e-mail" também sai
// (campo emailCodeEnabledAt): ele só existe junto do 2FA. Com --so-codigo-email
// só esse código extra é desligado e o 2FA continua ligado.
//
// Uso: node reset-2fa.mjs /data/users.json [--so-bloqueio | --so-codigo-email]
import { closeSync, fchownSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";

const file = process.argv[2];
const onlyLock = process.argv[3] === "--so-bloqueio";
const onlyEmail = process.argv[3] === "--so-codigo-email";
if (!file || (process.argv[3] !== undefined && !onlyLock && !onlyEmail)) {
  console.error("uso: node reset-2fa.mjs <caminho do users.json> [--so-bloqueio | --so-codigo-email]");
  process.exit(2);
}

const data = JSON.parse(readFileSync(file, "utf8"));
const users = Array.isArray(data.users) ? data.users : [];
const affected = users.filter((u) => u && (onlyEmail ? u.emailCodeEnabledAt : onlyLock ? u.twoFactor : u.twoFactor || u.emailCodeEnabledAt));
if (affected.length === 0) {
  console.log(
    onlyEmail
      ? "Nenhuma conta está com o código por e-mail ligado — nada a fazer."
      : "Nenhuma conta está com a verificação em duas etapas ativa — nada a fazer.",
  );
  process.exit(0);
}
const now = new Date().toISOString();
const clearLock = (tf) => {
  const { failedCodes, lockLevel, lockedUntil, ...rest } = tf;
  return rest;
};
const dropEmail = (u) => {
  const { emailCodeEnabledAt, ...rest } = u;
  return rest;
};
data.users = users.map((u) => {
  if (!u) return u;
  if (onlyEmail) return u.emailCodeEnabledAt ? { ...dropEmail(u), updatedAt: now } : u;
  if (onlyLock) return u.twoFactor ? { ...u, twoFactor: clearLock(u.twoFactor), updatedAt: now } : u;
  return u.twoFactor || u.emailCodeEnabledAt ? { ...dropEmail(u), twoFactor: null, updatedAt: now } : u;
});
// Gravação atômica: arquivo temporário na mesma pasta + rename. Uma queda no
// meio nunca deixa o users.json pela metade (ninguém mais entraria no painel).
const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
const original = statSync(file);
const fd = openSync(tmp, "wx", 0o600);
try {
  // o novo arquivo fica com o mesmo dono do antigo (o painel precisa conseguir lê-lo)
  try { fchownSync(fd, original.uid, original.gid); } catch {}
  writeSync(fd, JSON.stringify(data, null, 2) + "\n");
  fsyncSync(fd);
  closeSync(fd);
  renameSync(tmp, file);
} catch (err) {
  try { closeSync(fd); } catch {}
  try { unlinkSync(tmp); } catch {}
  throw err;
}
for (const u of affected) {
  console.log(
    onlyEmail
      ? `Código por e-mail desligado para: ${u.username} (a verificação em duas etapas continua ligada)`
      : onlyLock
      ? `Bloqueio do código de verificação limpo para: ${u.username} (a verificação continua ligada)`
      : `Verificação em duas etapas desligada para: ${u.username} (bloqueio por códigos errados também limpo)`,
  );
}
