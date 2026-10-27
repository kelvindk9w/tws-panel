/**
 * host-access.ts — comandos do host bridge para a gestão de ACESSO à VPS pelo
 * painel (Segurança → Acesso): chaves SSH do usuário de administração, senha
 * desse usuário no Linux e bloqueios do fail2ban.
 *
 * Mesma regra do restante do host bridge: strings montadas aqui, com cada
 * parâmetro validado e entrando entre aspas simples (os validadores não
 * admitem aspas); a allowlist só aceita o que o próprio construtor montaria,
 * comparado byte a byte. O painel NÃO ganha poder novo além disto: não abre
 * SSH por senha e não mexe no firewall por este caminho.
 *
 * A senha do Linux nunca vai no comando (apareceria na auditoria e no `ps`):
 * o comando é só `chpasswd`, e a linha `usuário:senha` segue pela entrada
 * padrão do helper.
 */
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { isValidSshUsername, parseSshPublicKey, type BanJail, type SshKeyInfo } from "@paas/core";

/** Jails do fail2ban que o painel mostra e libera. */
export const FAIL2BAN_JAILS = ["sshd", "recidive"] as const;

function userPrefix(user: string): string {
  if (!isValidSshUsername(user)) throw new Error(`usuário inválido: ${user.slice(0, 40)}`);
  return `u='${user}'; `;
}

/** Resolve a home e o grupo do usuário; sai com 3 se ele não existe. */
const RESOLVE_HOME =
  `h=$(getent passwd "$u" | cut -d: -f6); { [ -n "$h" ] && [ -d "$h" ]; } || { echo ::sem-usuario; exit 3; }; ` +
  `g=$(id -gn "$u") || exit 3; d="$h/.ssh"; f="$d/authorized_keys"; `;

const ENSURE_FILE =
  `install -d -m 700 -o "$u" -g "$g" "$d" || exit 4; ` +
  `[ -e "$f" ] || install -m 600 -o "$u" -g "$g" /dev/null "$f" || exit 4; ` +
  `bk="$f.paas-bak-$(date +%Y%m%d%H%M%S)"; cp -p "$f" "$bk" || exit 4; `;

const FINISH_FILE = `chown "$u:$g" "$f"; chmod 600 "$f"; `;

/** Lê o authorized_keys do usuário (somente leitura). */
export function buildSshKeysListCommand(user: string): string {
  return (
    userPrefix(user) +
    `h=$(getent passwd "$u" | cut -d: -f6); ` +
    `if [ -z "$h" ]; then echo ::sem-usuario; exit 3; fi; ` +
    `cat "$h/.ssh/authorized_keys" 2>/dev/null || true`
  );
}

/**
 * Acrescenta a chave (nunca substitui o arquivo): backup datado antes, linha
 * nova no fim, dono e permissões corretos. Se a chave já está lá, não repete.
 */
export function buildSshKeyAddCommand(user: string, publicKey: string): string {
  const key = parseSshPublicKey(publicKey);
  if (!key) throw new Error("chave pública SSH inválida");
  const line = `${key.type} ${key.blob}${key.comment ? ` ${key.comment}` : ""}`;
  return (
    userPrefix(user) +
    `k='${line}'; ` +
    RESOLVE_HOME +
    ENSURE_FILE +
    `if grep -qF -- '${key.blob}' "$f"; then echo ::ja-existe; exit 0; fi; ` +
    `{ [ ! -s "$f" ] || [ -z "$(tail -c1 "$f")" ] || echo >> "$f"; }; ` +
    `printf '%s\\n' "$k" >> "$f"; ` +
    FINISH_FILE +
    `echo ::adicionada`
  );
}

const BLOB_RE = /^[A-Za-z0-9+/]{40,800}={0,2}$/;

/**
 * Remove a(s) linha(s) que contêm esta chave. Recusa deixar o arquivo sem
 * nenhuma chave (sai com 5): o painel nunca tranca o dono do lado de fora.
 */
export function buildSshKeyRemoveCommand(user: string, blob: string): string {
  if (!BLOB_RE.test(blob)) throw new Error("chave inválida");
  const active = `grep -Ecv '^[[:space:]]*(#|$)'`;
  return (
    userPrefix(user) +
    `b='${blob}'; ` +
    RESOLVE_HOME +
    `[ -f "$f" ] || { echo ::nao-encontrada; exit 6; }; ` +
    `t=$(mktemp) || exit 4; ` +
    `awk -v b="$b" '{ keep = 1; for (i = 1; i <= NF; i++) if ($i == b) keep = 0; if (keep) print }' "$f" > "$t" || { rm -f "$t"; exit 4; }; ` +
    `before=$(${active} "$f" || true); after=$(${active} "$t" || true); ` +
    `if [ "\${after:-0}" -ge "\${before:-0}" ]; then rm -f "$t"; echo ::nao-encontrada; exit 6; fi; ` +
    `if [ "\${after:-0}" -lt 1 ]; then rm -f "$t"; echo ::ultima; exit 5; fi; ` +
    `bk="$f.paas-bak-$(date +%Y%m%d%H%M%S)"; cp -p "$f" "$bk" || { rm -f "$t"; exit 4; }; ` +
    `cat "$t" > "$f"; rm -f "$t"; ` +
    FINISH_FILE +
    `echo ::removida`
  );
}

/** A senha do usuário Linux: só `chpasswd`, com `usuário:senha` na entrada padrão. */
export const CHPASSWD_COMMAND = "chpasswd";

/** Linha para a entrada padrão do chpasswd. Recusa usuário inválido e senha com quebra de linha. */
export function buildChpasswdInput(user: string, password: string): string {
  if (!isValidSshUsername(user)) throw new Error(`usuário inválido: ${user.slice(0, 40)}`);
  if (/[\r\n\0]/.test(password) || password.length === 0) throw new Error("senha inválida");
  return `${user}:${password}\n`;
}

/** Lê os bloqueios do fail2ban (somente leitura). */
export const FAIL2BAN_LIST_COMMAND = `for j in ${FAIL2BAN_JAILS.join(" ")}; do echo "::jail $j"; fail2ban-client status "$j" 2>&1; done; true`;

/** Desbloqueia um IP nas duas jails; sai com 6 se ele não estava bloqueado em nenhuma. */
export function buildUnbanCommand(ip: string): string {
  if (ip.length > 45 || isIP(ip) === 0) throw new Error("endereço IP inválido");
  const loop = FAIL2BAN_JAILS.map((j) => `fail2ban-client set ${j} unbanip '${ip}' >/dev/null 2>&1 && ok=1`).join("; ");
  return `ok=0; ${loop}; if [ "$ok" = 1 ]; then echo ::desbloqueado; else echo ::nao-bloqueado; exit 6; fi`;
}

/** Impressões digitais da chave do servidor e a porta do SSH (kit de recuperação; somente leitura). */
export const SSH_FACTS_COMMAND =
  `for k in /etc/ssh/ssh_host_*_key.pub; do [ -f "$k" ] && ssh-keygen -lf "$k" 2>/dev/null; done; ` +
  `echo ::porta; sshd -T 2>/dev/null | grep -i '^port ' | head -n 1; true`;

/** Comandos fixos somente-leitura deste módulo (entram na allowlist). */
export const ACCESS_READ_ONLY_COMMANDS: readonly string[] = [FAIL2BAN_LIST_COMMAND, SSH_FACTS_COMMAND];

function safely(fn: () => string): string | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

/**
 * true só para um comando que um dos construtores acima montaria (ou o
 * `chpasswd` fixo). Fail-closed: extrai o parâmetro, reconstrói e compara.
 */
export function isAccessCommand(cmd: string): boolean {
  if (ACCESS_READ_ONLY_COMMANDS.includes(cmd) || cmd === CHPASSWD_COMMAND) return true;
  if (cmd.includes("\n") || cmd.includes("\r")) return false;
  const user = /^u='([a-z_][a-z0-9_-]{0,31})'; /.exec(cmd)?.[1];
  if (user !== undefined) {
    if (safely(() => buildSshKeysListCommand(user)) === cmd) return true;
    const key = /^u='[^']+'; k='([^']{50,2048})'; /.exec(cmd)?.[1];
    if (key !== undefined && safely(() => buildSshKeyAddCommand(user, key)) === cmd) return true;
    const blob = /^u='[^']+'; b='([A-Za-z0-9+/]{40,800}={0,2})'; /.exec(cmd)?.[1];
    return blob !== undefined && safely(() => buildSshKeyRemoveCommand(user, blob)) === cmd;
  }
  const ip = /^ok=0; fail2ban-client set sshd unbanip '([0-9a-fA-F:.]{2,45})'/.exec(cmd)?.[1];
  return ip !== undefined && safely(() => buildUnbanCommand(ip)) === cmd;
}

// ---------------------------------------------------------------------------
// Interpretação das saídas
// ---------------------------------------------------------------------------

/** SHA256:... da chave (mesmo formato do ssh-keygen -l). */
export function sshFingerprint(blob: string): string {
  const digest = createHash("sha256").update(Buffer.from(blob, "base64")).digest("base64").replace(/=+$/, "");
  return `SHA256:${digest}`;
}

const KEY_TOKEN_RE =
  /(?:^|\s)((?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]{40,}={0,2}(?: .*)?)$/;

/** Chaves do authorized_keys. Linhas que não são chave (comentário, vazias, tipos que o painel não conhece) são ignoradas. */
export function parseAuthorizedKeys(content: string): SshKeyInfo[] {
  const out: SshKeyInfo[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const direct = parseSshPublicKey(line);
    const embedded = direct ? null : KEY_TOKEN_RE.exec(line)?.[1];
    const key = direct ?? (embedded ? parseSshPublicKey(embedded) : null);
    if (!key) continue;
    out.push({
      fingerprint: sshFingerprint(key.blob),
      type: key.type,
      comment: key.comment,
      bits: key.bits,
      hasOptions: direct === null,
    });
  }
  return out;
}

/** O blob (base64) da chave com esta impressão digital no conteúdo do authorized_keys; null se não há. */
export function blobForFingerprint(content: string, fingerprint: string): string | null {
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const key = parseSshPublicKey(line) ?? parseSshPublicKey(KEY_TOKEN_RE.exec(line)?.[1] ?? "");
    if (key && sshFingerprint(key.blob) === fingerprint) return key.blob;
  }
  return null;
}

/** Bloqueios por jail a partir da saída de FAIL2BAN_LIST_COMMAND; null = o fail2ban não respondeu. */
export function parseFail2banList(output: string): BanJail[] | null {
  const jails: BanJail[] = [];
  let current: BanJail | null = null;
  let answered = false;
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    const jail = /^::jail (\w+)$/.exec(line);
    if (jail) {
      current = { jail: jail[1]!, ips: [] };
      jails.push(current);
      continue;
    }
    const banned = /^`?-?\s*Banned IP list:\s*(.*)$/.exec(line);
    if (banned && current) {
      answered = true;
      current.ips = banned[1]!.split(/\s+/).filter((ip) => ip.length > 0 && isIP(ip) !== 0);
    }
  }
  return answered ? jails : null;
}

/** Impressões digitais das chaves do servidor e a porta, da saída de SSH_FACTS_COMMAND. */
export function parseSshFacts(output: string): { hostKeys: string[]; port: number | null } {
  const [keysPart = "", rest = ""] = output.split("::porta");
  const hostKeys = keysPart
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\d+ SHA256:/.test(l));
  const port = Number(/^port\s+(\d{1,5})$/im.exec(rest)?.[1] ?? Number.NaN);
  return { hostKeys, port: Number.isInteger(port) && port > 0 && port < 65536 ? port : null };
}
