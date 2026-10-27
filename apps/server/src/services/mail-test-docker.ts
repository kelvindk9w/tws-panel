/**
 * mail-test-docker.ts — o container Mailpit da caixa de teste de e-mail de um projeto.
 *
 * É do PAINEL, não do compose do usuário: nome `paas-mailtest-<slug>` (espaço `paas-*`, que os
 * guardrails já reservam), sem a label `paas.project` (não entra em parar/iniciar/logs/backup do
 * projeto) e sem porta publicada. Duas redes, as duas INTERNAS (sem saída para a internet):
 *  - `paas-mailtest-<slug>`: a do projeto; os serviços dele entram nela e falam SMTP (1025);
 *  - `paas-mailtestadm`: a do painel; é por ela que o painel lê a API do Mailpit.
 * Sem relay: nenhuma opção de encaminhamento é configurada, e sem saída de rede não há para onde.
 *
 * Não coberto por teste unitário de cobertura (fala só com o Docker, como backup-docker.ts); o
 * teste mail-test-docker.test.ts confere os comandos com um dublê de `run`.
 */
import { isIP } from "node:net";
import { run, type ExecResult } from "@paas/deploy";
import {
  MAILPIT_IMAGE,
  PAAS_LABEL_MANAGED,
  PAAS_MAILTEST_ADMIN_NETWORK,
  mailTestContainerName,
  mailTestNetworkName,
  mailTestVolumeName,
} from "@paas/core";

export interface MailTestContainerSpec {
  slug: string;
  maxMessages: number;
  maxAgeDays: number;
  /** Usuário e senha da API/interface (só o painel os usa). */
  uiUser: string;
  uiPassword: string;
}

export type DockerRun = (file: string, args: string[], opts?: { timeoutMs?: number }) => Promise<ExecResult>;

/** Marca da configuração com que o container foi criado: mudou, recria (os dados ficam no volume). */
export function mailTestConfigMark(spec: Pick<MailTestContainerSpec, "maxMessages" | "maxAgeDays">): string {
  return `${MAILPIT_IMAGE}|${spec.maxMessages}|${spec.maxAgeDays}`;
}

export class MailTestDocker {
  constructor(private readonly exec: DockerRun = run) {}

  private async network(name: string): Promise<void> {
    if ((await this.exec("docker", ["network", "inspect", name])).code === 0) return;
    const create = await this.exec("docker", ["network", "create", "--internal", "--label", `${PAAS_LABEL_MANAGED}=true`, name]);
    // criada por outro pedido ao mesmo tempo: está pronta
    if (create.code !== 0 && !/already exists/i.test(create.stderr)) {
      throw new Error(`falha ao criar a rede ${name}: ${create.stderr.trim()}`);
    }
  }

  /** O painel entra na rede de leitura (só quando roda em container; fora dele alcança o IP do Mailpit pelo host). */
  async connectPanel(panelContainer: string): Promise<void> {
    await this.network(PAAS_MAILTEST_ADMIN_NETWORK);
    const inspect = await this.exec("docker", ["inspect", "-f", "{{json .NetworkSettings.Networks}}", panelContainer]);
    if (inspect.code !== 0) return;
    try {
      if (Object.prototype.hasOwnProperty.call(JSON.parse(inspect.stdout.trim() || "{}") as object, PAAS_MAILTEST_ADMIN_NETWORK)) return;
    } catch {
      // saída inesperada: tenta conectar
    }
    const connect = await this.exec("docker", ["network", "connect", PAAS_MAILTEST_ADMIN_NETWORK, panelContainer]);
    if (connect.code !== 0 && !/already exists|already connected/i.test(connect.stderr)) {
      throw new Error(`falha ao conectar o painel à rede ${PAAS_MAILTEST_ADMIN_NETWORK}: ${connect.stderr.trim()}`);
    }
  }

  async status(slug: string): Promise<{ installed: boolean; running: boolean }> {
    const inspect = await this.exec("docker", ["inspect", "-f", "{{.State.Running}}", mailTestContainerName(slug)]);
    if (inspect.code !== 0) return { installed: false, running: false };
    return { installed: true, running: inspect.stdout.trim() === "true" };
  }

  /** IP do Mailpit na rede de leitura do painel (null = fora dela). */
  async address(slug: string): Promise<string | null> {
    const inspect = await this.exec("docker", ["inspect", "-f", "{{json .NetworkSettings.Networks}}", mailTestContainerName(slug)]);
    if (inspect.code !== 0) return null;
    try {
      const nets = JSON.parse(inspect.stdout.trim()) as Record<string, { IPAddress?: string }>;
      const ip = nets[PAAS_MAILTEST_ADMIN_NETWORK]?.IPAddress ?? "";
      return isIP(ip) ? ip : null;
    } catch {
      return null;
    }
  }

  /** Sobe (ou garante) o Mailpit do projeto. Idempotente: container certo e rodando não é tocado. */
  async ensure(spec: MailTestContainerSpec): Promise<void> {
    const name = mailTestContainerName(spec.slug);
    const net = mailTestNetworkName(spec.slug);
    await this.network(PAAS_MAILTEST_ADMIN_NETWORK);
    await this.network(net);
    const inspect = await this.exec("docker", ["inspect", "-f", '{{.State.Running}}|{{index .Config.Labels "paas.mailtest.config"}}', name]);
    if (inspect.code === 0) {
      const text = inspect.stdout.trim();
      const cut = text.indexOf("|");
      const running = text.slice(0, cut);
      const mark = text.slice(cut + 1);
      if (mark === mailTestConfigMark(spec)) {
        await this.attach(name);
        if (running === "true") return;
        if ((await this.exec("docker", ["start", name])).code === 0) return;
      }
      // configuração nova (retenção, imagem) ou container quebrado: recria; as mensagens ficam no volume
      await this.exec("docker", ["rm", "-f", name]);
    }
    const create = await this.exec("docker", [
      "create",
      "--name",
      name,
      "--restart",
      "unless-stopped",
      "--network",
      net,
      // sem -p: ninguém de fora alcança o Mailpit
      "-v",
      `${mailTestVolumeName(spec.slug)}:/data`,
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--memory",
      "128m",
      "--memory-swap",
      "128m",
      "--cpus",
      "0.25",
      "--pids-limit",
      "128",
      "-e",
      "MP_DATABASE=/data/mailpit.db",
      "-e",
      `MP_MAX_MESSAGES=${spec.maxMessages}`,
      "-e",
      `MP_MAX_AGE=${spec.maxAgeDays * 24}h`,
      // o app manda usuário e senha em texto puro: aceita qualquer um (a rede é interna e só do projeto)
      "-e",
      "MP_SMTP_AUTH_ACCEPT_ANY=1",
      "-e",
      "MP_SMTP_AUTH_ALLOW_INSECURE=1",
      "-e",
      `MP_UI_AUTH=${spec.uiUser}:${spec.uiPassword}`,
      "-e",
      "MP_DISABLE_VERSION_CHECK=1",
      "--label",
      `${PAAS_LABEL_MANAGED}=true`,
      "--label",
      "paas.role=mailtest",
      "--label",
      `paas.mailtest=${spec.slug}`,
      "--label",
      `paas.mailtest.config=${mailTestConfigMark(spec)}`,
      MAILPIT_IMAGE,
    ]);
    if (create.code !== 0) throw new Error(`falha ao criar ${name}: ${create.stderr.trim()}`);
    await this.attach(name);
    const start = await this.exec("docker", ["start", name]);
    if (start.code !== 0) throw new Error(`falha ao iniciar ${name}: ${start.stderr.trim()}`);
  }

  /** Liga o container à rede de leitura do painel (a rede do projeto ele já tem desde a criação). */
  private async attach(name: string): Promise<void> {
    const connect = await this.exec("docker", ["network", "connect", PAAS_MAILTEST_ADMIN_NETWORK, name]);
    if (connect.code !== 0 && !/already exists|already connected/i.test(connect.stderr)) {
      throw new Error(`falha ao ligar ${name} à rede ${PAAS_MAILTEST_ADMIN_NETWORK}: ${connect.stderr.trim()}`);
    }
  }

  /**
   * Remove o container. `deleteData` também apaga o volume com as mensagens e a rede do projeto
   * (a rede só sai quando nenhum container do projeto está nela; se ainda está, fica para depois).
   */
  async remove(slug: string, opts: { deleteData: boolean }): Promise<void> {
    const name = mailTestContainerName(slug);
    const rm = await this.exec("docker", ["rm", "-f", name]);
    if (rm.code !== 0 && !/no such container/i.test(rm.stderr)) throw new Error(`falha ao remover ${name}: ${rm.stderr.trim()}`);
    // a rede do projeto: sai se ninguém a usa mais (o projeto ainda pode estar ligado a ela até reiniciar)
    await this.exec("docker", ["network", "rm", mailTestNetworkName(slug)]);
    if (opts.deleteData) {
      const volume = await this.exec("docker", ["volume", "rm", "-f", mailTestVolumeName(slug)]);
      if (volume.code !== 0 && !/no such volume/i.test(volume.stderr)) {
        throw new Error(`falha ao apagar as mensagens (${volume.stderr.trim()})`);
      }
    }
  }
}
