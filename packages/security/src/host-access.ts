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
import { isValidSshUsername, parseSshPublicKey, type BanJail, type OtherKeyInfo, type SshKeyInfo } from "@paas/core";

/** Jails do fail2ban que o painel mostra e libera. */
export const FAIL2BAN_JAILS = ["sshd", "recidive"] as const;

/**
 * Único usuário cuja senha o painel troca (o de administração, PAAS_TERMINAL_USER). Definido na subida do
 * servidor; sem ele a allowlist recusa o chpasswd (fail-closed): nenhuma outra conta tem a senha trocada por aqui.
 */
let adminUser: string | null = null;
export function setAccessAdminUser(user: string | null): void {
  adminUser = user && isValidSshUsername(user) ? user : null;
}

function userPrefix(user: string): string {
  if (!isValidSshUsername(user)) throw new Error(`usuário inválido: ${user.slice(0, 40)}`);
  return `u='${user}'; `;
}

/** PATH fixo do script que roda como o usuário (`env -i`): nada do ambiente do helper vaza para ele. */
const SAFE_PATH = "/usr/sbin:/usr/bin:/sbin:/bin";

/** Resolve a home do usuário; sai com 3 se ele não existe. Nada aqui escreve em arquivo. */
const RESOLVE_HOME =
  `h=$(getent passwd "$u" | cut -d: -f6); { [ -n "$h" ] && [ -d "$h" ]; } || { echo ::sem-usuario; exit 3; }; ` +
  `d="$h/.ssh"; f="$d/authorized_keys"; ` +
  `command -v runuser >/dev/null 2>&1 || { echo ::sem-runuser; exit 8; }; `;

/**
 * Tudo que mexe no ~/.ssh roda COMO O PRÓPRIO USUÁRIO (runuser), nunca como root:
 * um link simbólico plantado em ~/.ssh ou em authorized_keys só dá ao usuário o
 * que ele já tem. Além disso o script recusa (exit 7) link simbólico, arquivo
 * que não é comum, pasta de outro dono ou gravável por grupo/outros. A escrita
 * é atômica (temporário na mesma pasta + mv) e serializada com flock (espera no máximo 10 s: exit 9), e só os
 * 5 backups mais novos ficam. O script não tem aspas simples (vai entre elas).
 */
const USER_GUARD =
  `set -e; umask 077; f=$1; d=$(dirname "$f"); ` +
  `if [ ! -e "$d" ] && [ ! -L "$d" ]; then mkdir -m 700 "$d" || exit 4; fi; ` +
  `{ [ -d "$d" ] && [ ! -L "$d" ] && [ -O "$d" ] && [ -z "$(find "$d" -maxdepth 0 -perm /022)" ]; } || exit 7; ` +
  `if [ -e "$f" ] || [ -L "$f" ]; then { [ -f "$f" ] && [ ! -L "$f" ] && [ -O "$f" ]; } || exit 7; fi; ` +
  `exec 9>>"$d/.paas-lock"; flock -w 10 -x 9 || exit 9; `;

const PRUNE_BACKUPS = `ls -1t "$f".paas-bak-* 2>/dev/null | tail -n +6 | while IFS= read -r o; do rm -f "$o"; done; `;

const ADD_SCRIPT =
  USER_GUARD +
  `k=$2; b=$3; ` +
  `[ -e "$f" ] || : > "$f"; ` +
  `if grep -v "^[[:space:]]*#" "$f" | grep -qF -- "$b"; then echo ::ja-existe; exit 0; fi; ` +
  `cp -p "$f" "$f.paas-bak-$(date +%Y%m%d%H%M%S)" || exit 4; ` +
  `t=$(mktemp "$d/.ak.XXXXXX") || exit 4; ` +
  `cat "$f" > "$t"; { [ ! -s "$t" ] || [ -z "$(tail -c1 "$t")" ] || echo >> "$t"; }; ` +
  `printf "%s\\n" "$k" >> "$t"; chmod 600 "$t"; mv -f "$t" "$f"; ` +
  PRUNE_BACKUPS +
  `echo ::adicionada`;

const KEY_TYPES_RE = `^[[:space:]]*(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521))[[:space:]]`;

const REMOVE_SCRIPT =
  `[ -e "$1" ] || { echo ::nao-encontrada; exit 6; }; ` +
  USER_GUARD +
  `b=$2; ` +
  `[ -f "$f" ] || { echo ::nao-encontrada; exit 6; }; ` +
  `t=$(mktemp "$d/.ak.XXXXXX") || exit 4; ` +
  `awk -v b="$b" "{ keep = 1; for (i = 1; i <= NF; i++) if (\\$i == b) keep = 0; if (keep) print }" "$f" > "$t" || { rm -f "$t"; exit 4; }; ` +
  `before=$(grep -Ecv "^[[:space:]]*(#|\\$)" "$f" || true); after=$(grep -Ecv "^[[:space:]]*(#|\\$)" "$t" || true); ` +
  `if [ "\${after:-0}" -ge "\${before:-0}" ]; then rm -f "$t"; echo ::nao-encontrada; exit 6; fi; ` +
  `free=$(grep -Ec "${KEY_TYPES_RE}" "$t" || true); ` +
  `if [ "\${free:-0}" -lt 1 ]; then rm -f "$t"; echo ::ultima; exit 5; fi; ` +
  `cp -p "$f" "$f.paas-bak-$(date +%Y%m%d%H%M%S)" || { rm -f "$t"; exit 4; }; ` +
  `chmod 600 "$t"; mv -f "$t" "$f"; ` +
  PRUNE_BACKUPS +
  `echo ::removida`;

/** Marca, no canal de ERRO da leitura (nunca no conteúdo do arquivo, que não pode forjá-la), de que existe um authorized_keys2 com conteúdo. */
export const KEYS2_MARK = "::authorized-keys2";

/** Lê o authorized_keys do usuário (somente leitura) e avisa se há um authorized_keys2. */
export function buildSshKeysListCommand(user: string): string {
  return (
    userPrefix(user) +
    `h=$(getent passwd "$u" | cut -d: -f6); ` +
    `if [ -z "$h" ]; then echo ::sem-usuario; exit 3; fi; ` +
    `command -v runuser >/dev/null 2>&1 || { echo ::sem-runuser; exit 8; }; ` +
    `runuser -u "$u" -- cat "$h/.ssh/authorized_keys" 2>/dev/null || true; ` +
    `runuser -u "$u" -- test -s "$h/.ssh/authorized_keys2" 2>/dev/null && echo ${KEYS2_MARK} >&2; true`
  );
}

/**
 * Acrescenta a chave (nunca substitui o arquivo): backup datado antes, linha
 * nova no fim, gravação atômica. Se a chave já está lá, não repete.
 */
export function buildSshKeyAddCommand(user: string, publicKey: string): string {
  const key = parseSshPublicKey(publicKey);
  if (!key) throw new Error("chave pública SSH inválida");
  const line = `${key.type} ${key.blob}${key.comment ? ` ${key.comment}` : ""}`;
  return (
    userPrefix(user) +
    `k='${line}'; ` +
    RESOLVE_HOME +
    `runuser -u "$u" -- env -i PATH=${SAFE_PATH} sh -c '${ADD_SCRIPT}' sh "$f" "$k" '${key.blob}'`
  );
}

const BLOB_RE = /^[A-Za-z0-9+/]{40,800}={0,2}$/;

/**
 * Remove a(s) linha(s) que contêm esta chave. Recusa deixar o arquivo sem
 * nenhuma chave SEM restrição (sai com 5): uma chave com `from=`/`command=`
 * não conta, porque pode não servir de qualquer lugar. O painel nunca tranca
 * o dono do lado de fora.
 */
export function buildSshKeyRemoveCommand(user: string, blob: string): string {
  if (!BLOB_RE.test(blob)) throw new Error("chave inválida");
  return (
    userPrefix(user) +
    `b='${blob}'; ` +
    RESOLVE_HOME +
    `runuser -u "$u" -- env -i PATH=${SAFE_PATH} sh -c '${REMOVE_SCRIPT}' sh "$f" "$b"`
  );
}

/**
 * A senha do usuário Linux: o comando é fixo e AMARRADO ao usuário (a allowlist
 * não aceita `chpasswd` solto, que trocaria a senha de qualquer conta). A senha
 * em si segue só pela entrada padrão (uma linha), nunca no comando.
 */
export function buildChpasswdCommand(user: string): string {
  return userPrefix(user) + `IFS= read -r p || exit 4; printf '%s:%s\\n' "$u" "$p" | chpasswd`;
}

/** Linha para a entrada padrão do comando acima. Recusa senha vazia ou com quebra de linha/NUL. */
export function buildChpasswdInput(password: string): string {
  if (/[\r\n\0]/.test(password) || password.length === 0) throw new Error("senha inválida");
  return `${password}\n`;
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

/** Arquivo(s) de chaves que o sshd realmente lê (somente leitura; vazio se o sshd não responde). */
export const SSH_KEYFILE_COMMAND = `sshd -T 2>/dev/null | grep -i '^authorizedkeysfile ' | head -n 1; true`;

/** Comandos fixos somente-leitura deste módulo (entram na allowlist). */
export const ACCESS_READ_ONLY_COMMANDS: readonly string[] = [FAIL2BAN_LIST_COMMAND, SSH_FACTS_COMMAND, SSH_KEYFILE_COMMAND];

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
  if (ACCESS_READ_ONLY_COMMANDS.includes(cmd)) return true;
  if (cmd.includes("\n") || cmd.includes("\r")) return false;
  const user = /^u='([a-z_][a-z0-9_-]{0,31})'; /.exec(cmd)?.[1];
  if (user !== undefined) {
    if (safely(() => buildSshKeysListCommand(user)) === cmd) return true;
    if (user === adminUser && safely(() => buildChpasswdCommand(user)) === cmd) return true;
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

/**
 * Linhas do authorized_keys que o painel não gere: tipos não reconhecidos (sk-*, certificados, ssh-dss).
 * Somente para mostrar; remover continua do lado seguro (essas linhas nunca contam como chave livre).
 */
export function parseOtherKeys(content: string): OtherKeyInfo[] {
  const out: OtherKeyInfo[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const direct = parseSshPublicKey(line);
    if (direct || (KEY_TOKEN_RE.exec(line)?.[1] && parseSshPublicKey(KEY_TOKEN_RE.exec(line)![1]!))) continue;
    const m = /(?:^|\s)((?:sk-)?[a-z0-9-]+(?:-cert-v01)?(?:@openssh\.com)?|ssh-dss)\s+([A-Za-z0-9+/]{16,}={0,2})(?:\s+(.*))?$/.exec(line);
    const looksKey = m && /^(sk-|ssh-|ecdsa-)/.test(m[1]!);
    if (!m || !looksKey) {
      out.push({ type: "desconhecido", fingerprint: null, comment: "" });
      continue;
    }
    out.push({ type: m[1]!, fingerprint: sshFingerprint(m[2]!), comment: (m[3] ?? "").trim().slice(0, 100) });
  }
  return out;
}

/** O authorized_keys2 tem conteúdo? Recebe o STDERR da leitura (buildSshKeysListCommand), onde a marca é escrita. */
export function hasAuthorizedKeys2(stderr: string): boolean {
  return stderr.split("\n").some((l) => l.trim() === KEYS2_MARK);
}

/**
 * AuthorizedKeysFile do sshd (saída de SSH_KEYFILE_COMMAND). Devolve null quando é o padrão
 * (ou quando o sshd não respondeu: aí vale o padrão) e o texto configurado quando é outro.
 */
export function parseCustomKeyFile(output: string): string | null {
  const m = /^authorizedkeysfile\s+(.+)$/im.exec(output.trim());
  if (!m) return null;
  const files = m[1]!.trim().split(/\s+/);
  const std = (f: string) => f === ".ssh/authorized_keys" || f === "%h/.ssh/authorized_keys";
  const std2 = (f: string) => f === ".ssh/authorized_keys2" || f === "%h/.ssh/authorized_keys2";
  if (std(files[0]!) && files.slice(1).every(std2)) return null;
  return files.join(" ").slice(0, 200);
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
