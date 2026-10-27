/**
 * access-service.ts — gestão do ACESSO à VPS pelo painel (Segurança → Acesso):
 * chaves SSH e senha Linux do usuário de administração e bloqueios do fail2ban.
 *
 * Tudo passa pelo host bridge (allowlist + auditoria de cada comando, ver
 * packages/security/src/host-access.ts). O painel NÃO abre SSH por senha e NÃO
 * mexe no firewall por este caminho: só acrescenta/remove chave pública do
 * usuário de administração, troca a senha dele e desbloqueia IPs.
 *
 * O usuário é o do terminal (PAAS_TERMINAL_USER). Sem ele (instalação antiga que
 * abre o terminal como root) ou fora da VPS real, a gestão fica indisponível e a
 * tela diz por quê.
 */
import {
  checkNewSshPublicKey,
  linuxPasswordErrors,
  type AccessStatusResponse,
  type BanJail,
  type SshKeyInfo,
} from "@paas/core";
import {
  PASSWORD_WINDOW_COMMAND,
  buildChpasswdCommand,
  parsePasswordWindow,
  FAIL2BAN_LIST_COMMAND,
  SSH_FACTS_COMMAND,
  blobForFingerprint,
  buildChpasswdInput,
  buildSshKeyAddCommand,
  buildSshKeyRemoveCommand,
  buildSshKeysListCommand,
  buildUnbanCommand,
  parseAuthorizedKeys,
  parseFail2banList,
  parseSshFacts,
  sshFingerprint,
} from "@paas/security";
import { httpError } from "./http-error.js";

/** O mínimo do NsenterHostRunner que a gestão de acesso usa. */
export interface AccessRunner {
  ensureReady(): Promise<void>;
  exec(cmd: string, opts?: { timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }>;
  execWithInput(
    cmd: string,
    input: string,
    opts?: { timeoutMs?: number },
  ): Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface AccessAudit {
  record(input: { action: string; detail: string; actor?: string; target?: string | null }): Promise<unknown>;
}

export interface AccessServiceOptions {
  /** null = fora da VPS real (desenvolvimento/teste). */
  runner: AccessRunner | null;
  /** Usuário de administração (o do terminal); null/root = não dá para gerir. */
  user: string | null;
  audit?: AccessAudit;
}

function firstLine(text: string): string {
  return text.split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 200) ?? "";
}

export class AccessService {
  constructor(private readonly opts: AccessServiceOptions) {}

  /** Disponibilidade e usuário; `reason` explica o que falta quando não está. */
  availability(): { available: boolean; reason: string | null; user: string | null } {
    if (!this.opts.runner) {
      return {
        available: false,
        reason: "Esta função só existe no painel instalado na VPS (modo de desenvolvimento ou teste não alcança o servidor).",
        user: null,
      };
    }
    const user = this.opts.user;
    if (!user || user === "root") {
      return {
        available: false,
        reason:
          "Esta instalação abre o terminal como root, e a gestão de chaves usa o usuário de administração. " +
          "Crie esse usuário na fase 01 do hardening (Segurança) e reinstale com PAAS_TERMINAL_USER.",
        user: null,
      };
    }
    return { available: true, reason: null, user };
  }

  private requireReady(): { runner: AccessRunner; user: string } {
    const a = this.availability();
    if (!a.available) throw httpError(409, "access_unavailable", a.reason!);
    return { runner: this.opts.runner!, user: a.user! };
  }

  private async rawKeys(): Promise<string> {
    const { runner, user } = this.requireReady();
    await runner.ensureReady();
    const r = await runner.exec(buildSshKeysListCommand(user), { timeoutMs: 30_000 });
    if (r.stdout.includes("::sem-usuario")) {
      throw httpError(409, "user_not_found", `O usuário ${user} não existe na VPS.`);
    }
    if (r.code !== 0) throw httpError(502, "host_failed", `Não foi possível ler as chaves: ${firstLine(r.stderr) || `código ${r.code}`}`);
    return r.stdout;
  }

  async status(flags: { twoFactorEnabled: boolean; emailCodeEnabled: boolean }): Promise<AccessStatusResponse> {
    const a = this.availability();
    const base: AccessStatusResponse = { ...a, ...flags, keys: [], keysError: null, passwordWindow: null };
    if (!a.available) return base;
    const passwordWindow = await this.passwordWindow();
    try {
      return { ...base, passwordWindow, keys: parseAuthorizedKeys(await this.rawKeys()) };
    } catch (err) {
      return { ...base, passwordWindow, keysError: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Janela de SSH por senha (aberta pelo console do provedor) ainda aberta? null = não deu para saber. */
  private async passwordWindow(): Promise<{ open: boolean; expiresAt: string | null } | null> {
    try {
      const { runner } = this.requireReady();
      await runner.ensureReady();
      const r = await runner.exec(PASSWORD_WINDOW_COMMAND, { timeoutMs: 15_000 });
      return parsePasswordWindow(r.stdout);
    } catch {
      return null;
    }
  }

  async listKeys(): Promise<SshKeyInfo[]> {
    return parseAuthorizedKeys(await this.rawKeys());
  }

  async addKey(publicKey: string, actor: string): Promise<SshKeyInfo> {
    const checked = checkNewSshPublicKey(publicKey);
    if (!checked.ok) throw httpError(400, "invalid_public_key", checked.reason);
    const { runner, user } = this.requireReady();
    await runner.ensureReady();
    const r = await runner.exec(buildSshKeyAddCommand(user, publicKey.trim()), { timeoutMs: 30_000 });
    if (r.code === 7) {
      throw httpError(
        409,
        "ssh_dir_unsafe",
        "A pasta ~/.ssh ou o authorized_keys do usuário não está como deveria (link simbólico, outro dono ou gravável por outros). Por segurança o painel não mexe nele: corrija pelo console do provedor.",
      );
    }
    if (r.stdout.includes("::ja-existe")) throw httpError(409, "key_exists", "Esta chave já está cadastrada.");
    if (r.stdout.includes("::sem-usuario")) throw httpError(409, "user_not_found", `O usuário ${user} não existe na VPS.`);
    if (r.code !== 0 || !r.stdout.includes("::adicionada")) {
      throw httpError(502, "host_failed", `Não foi possível gravar a chave: ${firstLine(r.stderr) || `código ${r.code}`}`);
    }
    const info: SshKeyInfo = {
      fingerprint: sshFingerprint(checked.key.blob),
      type: checked.key.type,
      comment: checked.key.comment,
      bits: checked.key.bits,
      hasOptions: false,
    };
    await this.audit(actor, "auth.ssh_key_added", `Chave SSH adicionada ao usuário ${user}: ${info.fingerprint} (${info.type}${info.comment ? `, ${info.comment}` : ""}).`);
    return info;
  }

  async removeKey(fingerprint: string, actor: string): Promise<void> {
    const { runner, user } = this.requireReady();
    const content = await this.rawKeys();
    const keys = parseAuthorizedKeys(content);
    const blob = blobForFingerprint(content, fingerprint);
    if (!blob) throw httpError(404, "key_not_found", "Essa chave não está mais na lista. Atualize a página.");
    // só conta como "restante" a chave SEM restrição (from=/command=): uma restrita pode não servir de onde o dono está
    if (!keys.some((k) => k.fingerprint !== fingerprint && !k.hasOptions)) {
      throw httpError(
        409,
        "last_key",
        "Esta é a única chave sem restrição do usuário. O painel não remove a última para você não ficar trancado fora: adicione outra (e teste-a numa janela nova) antes.",
      );
    }
    const r = await runner.exec(buildSshKeyRemoveCommand(user, blob), { timeoutMs: 30_000 });
    if (r.code === 7) {
      throw httpError(
        409,
        "ssh_dir_unsafe",
        "A pasta ~/.ssh ou o authorized_keys do usuário não está como deveria (link simbólico, outro dono ou gravável por outros). Por segurança o painel não mexe nele: corrija pelo console do provedor.",
      );
    }
    if (r.stdout.includes("::ultima")) {
      throw httpError(409, "last_key", "Esta é a única chave sem restrição do usuário. Adicione outra antes de remover esta.");
    }
    if (r.stdout.includes("::nao-encontrada")) throw httpError(404, "key_not_found", "Essa chave não está mais na lista. Atualize a página.");
    if (r.code !== 0 || !r.stdout.includes("::removida")) {
      throw httpError(502, "host_failed", `Não foi possível remover a chave: ${firstLine(r.stderr) || `código ${r.code}`}`);
    }
    await this.audit(actor, "auth.ssh_key_removed", `Chave SSH removida do usuário ${user}: ${fingerprint}.`);
  }

  /** Troca a senha do usuário de administração no Linux (a que abre o console do provedor e o sudo). */
  async setLinuxPassword(password: string, actor: string): Promise<void> {
    const { runner, user } = this.requireReady();
    const errors = linuxPasswordErrors(password);
    if (errors.length > 0) throw httpError(400, "weak_linux_password", `Senha inválida: ${errors.join(", ")}.`);
    await runner.ensureReady();
    const r = await runner.execWithInput(buildChpasswdCommand(user), buildChpasswdInput(password), { timeoutMs: 30_000 });
    if (r.code !== 0) {
      // o chpasswd/PAM explica o motivo (senha fraca demais, por exemplo); nunca repete a senha
      const why = firstLine(r.stderr).split(password).join("***");
      throw httpError(502, "host_failed", `A VPS recusou a nova senha${why ? `: ${why}` : ` (código ${r.code})`}.`);
    }
    await this.audit(actor, "auth.linux_password_changed", `Senha do usuário ${user} na VPS alterada pelo painel.`);
  }

  async bans(): Promise<{ available: boolean; reason: string | null; jails: BanJail[] }> {
    if (!this.opts.runner) return { available: false, reason: this.availability().reason, jails: [] };
    await this.opts.runner.ensureReady();
    const r = await this.opts.runner.exec(FAIL2BAN_LIST_COMMAND, { timeoutMs: 30_000 });
    const jails = parseFail2banList(r.stdout);
    if (!jails) {
      return {
        available: false,
        reason: "O fail2ban não está ativo nesta VPS (fase 04 do hardening). Sem ele não há bloqueios para mostrar.",
        jails: [],
      };
    }
    return { available: true, reason: null, jails };
  }

  async unban(ip: string, actor: string): Promise<void> {
    if (!this.opts.runner) throw httpError(409, "access_unavailable", this.availability().reason!);
    let command: string;
    try {
      command = buildUnbanCommand(ip);
    } catch {
      throw httpError(400, "invalid_ip", "Endereço IP inválido.");
    }
    await this.opts.runner.ensureReady();
    const r = await this.opts.runner.exec(command, { timeoutMs: 30_000 });
    if (r.stdout.includes("::nao-bloqueado")) {
      throw httpError(404, "not_banned", "Esse IP não está bloqueado agora (talvez o bloqueio já tenha acabado).");
    }
    if (r.code !== 0 || !r.stdout.includes("::desbloqueado")) {
      throw httpError(502, "host_failed", `Não foi possível desbloquear: ${firstLine(r.stderr) || `código ${r.code}`}`);
    }
    await this.audit(actor, "auth.fail2ban_unban", `IP ${ip} desbloqueado no fail2ban pelo painel.`);
  }

  /** Chave do servidor e porta do SSH (kit de recuperação). Falha vira vazio: o kit sai sem esses itens. */
  async sshFacts(): Promise<{ hostKeys: string[]; port: number | null }> {
    if (!this.opts.runner) return { hostKeys: [], port: null };
    try {
      await this.opts.runner.ensureReady();
      const r = await this.opts.runner.exec(SSH_FACTS_COMMAND, { timeoutMs: 30_000 });
      return parseSshFacts(r.stdout);
    } catch {
      return { hostKeys: [], port: null };
    }
  }

  async recordKit(actor: string): Promise<void> {
    await this.audit(actor, "auth.recovery_kit", "Kit de recuperação de acesso gerado (sem segredos).");
  }

  private async audit(actor: string, action: string, detail: string): Promise<void> {
    await this.opts.audit?.record({ action, detail, actor, target: "acesso à VPS" }).catch(() => undefined);
  }
}
