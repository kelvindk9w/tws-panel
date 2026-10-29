/**
 * mail-test-docker.ts — o container Mailpit da caixa de teste de e-mail de um projeto.
 *
 * É do PAINEL, não do compose do usuário: nome `paas-mailtest-<slug>` (espaço `paas-*`, que os
 * guardrails já reservam), sem a label `paas.project` (não entra em parar/iniciar/logs/backup do
 * projeto) e sem porta publicada. Duas redes por projeto, as duas INTERNAS (sem saída para a internet), em
 * sub-redes que o Docker escolhe:
 *  - `paas-mailtest-<slug>`: a do projeto; os serviços dele entram nela e falam SMTP (1025). A interface/API (:8025)
 *    escuta em todos os endereços, então TAMBÉM responde nessa rede; quem protege é a senha forte (MP_UI_AUTH);
 *  - `paas-mailtestadm-<slug>`: a de leitura, só do painel e deste Mailpit (um Mailpit não alcança o de outro projeto).
 * Sem relay: nenhuma opção de encaminhamento é configurada, e sem saída de rede não há para onde.
 * O container é read-only (só /data e /tmp graváveis), o log dele tem teto e cada mensagem tem tamanho máximo.
 *
 * Não coberto por teste unitário de cobertura (fala só com o Docker, como backup-docker.ts); o
 * teste mail-test-docker.test.ts confere os comandos com um dublê de `run`.
 */
import { isIP } from "node:net";
import { run, type ExecResult } from "@paas/deploy";
import {
  MAILPIT_IMAGE,
  PAAS_LABEL_MANAGED,
  mailTestAdminNetworkName,
  mailTestContainerName,
  mailTestMaxMessageMb,
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
  return `${MAILPIT_IMAGE}|${spec.maxMessages}|${spec.maxAgeDays}|${mailTestMaxMessageMb(spec.maxMessages)}MB|ro3`;
}

export class MailTestDocker {
  constructor(private readonly exec: DockerRun = run) {}

  /** Garante uma rede INTERNA com este nome (o Docker escolhe a sub-rede). */
  private async network(name: string): Promise<void> {
    const inspect = await this.exec("docker", ["network", "inspect", "-f", "{{.Internal}}", name]);
    if (inspect.code === 0) {
      if (inspect.stdout.trim() === "true") return;
      // existe mas TEM saída para a internet: a garantia "sem saída" não vale. Recria como interna ou recusa.
      const gone = await this.exec("docker", ["network", "rm", name]);
      if (gone.code !== 0) {
        throw new Error(`a rede ${name} existe e não é interna (tem saída para a internet) e não pôde ser recriada: ${gone.stderr.trim()}`);
      }
    }
    const create = await this.exec("docker", ["network", "create", "--internal", "--label", `${PAAS_LABEL_MANAGED}=true`, name]);
    // criada por outro pedido ao mesmo tempo: está pronta
    if (create.code !== 0 && !/already exists/i.test(create.stderr)) {
      throw new Error(`falha ao criar a rede ${name}: ${create.stderr.trim()}`);
    }
  }

  /** O painel entra na rede de leitura DESTE projeto (só quando roda em container; fora dele alcança o IP pelo host). */
  async connectPanel(slug: string, panelContainer: string): Promise<void> {
    const net = mailTestAdminNetworkName(slug);
    await this.network(net);
    const inspect = await this.exec("docker", ["inspect", "-f", "{{json .NetworkSettings.Networks}}", panelContainer]);
    if (inspect.code !== 0) return;
    try {
      if (Object.prototype.hasOwnProperty.call(JSON.parse(inspect.stdout.trim() || "{}") as object, net)) return;
    } catch {
      // saída inesperada: tenta conectar
    }
    const connect = await this.exec("docker", ["network", "connect", net, panelContainer]);
    if (connect.code !== 0 && !/already exists|already connected/i.test(connect.stderr)) {
      throw new Error(`falha ao conectar o painel à rede ${net}: ${connect.stderr.trim()}`);
    }
  }

  async status(slug: string): Promise<{ installed: boolean; running: boolean }> {
    const inspect = await this.exec("docker", ["inspect", "-f", "{{.State.Running}}", mailTestContainerName(slug)]);
    if (inspect.code !== 0) return { installed: false, running: false };
    return { installed: true, running: inspect.stdout.trim() === "true" };
  }

  /** IP do Mailpit na rede de leitura do projeto (null = fora dela). */
  async address(slug: string): Promise<string | null> {
    const inspect = await this.exec("docker", ["inspect", "-f", "{{json .NetworkSettings.Networks}}", mailTestContainerName(slug)]);
    if (inspect.code !== 0) return null;
    try {
      const nets = JSON.parse(inspect.stdout.trim()) as Record<string, { IPAddress?: string }>;
      const ip = nets[mailTestAdminNetworkName(slug)]?.IPAddress ?? "";
      return isIP(ip) ? ip : null;
    } catch {
      return null;
    }
  }

  /** Sobe (ou garante) o Mailpit do projeto. Idempotente: container certo e rodando não é tocado. */
  async ensure(spec: MailTestContainerSpec): Promise<void> {
    const name = mailTestContainerName(spec.slug);
    const net = mailTestNetworkName(spec.slug);
    const readNet = mailTestAdminNetworkName(spec.slug);
    await this.network(readNet);
    await this.network(net);
    const mark = mailTestConfigMark(spec);
    const inspect = await this.exec("docker", ["inspect", "-f", '{{.State.Running}}|{{index .Config.Labels "paas.mailtest.config"}}', name]);
    if (inspect.code === 0) {
      const text = inspect.stdout.trim();
      const cut = text.indexOf("|");
      const running = text.slice(0, cut);
      const found = text.slice(cut + 1);
      if (found === mark) {
        await this.attach(name, net);
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
      // nasce na rede de leitura; a rede do projeto (SMTP) entra em attach()
      "--network",
      readNet,
      // sem -p: ninguém de fora alcança o Mailpit
      "-v",
      `${mailTestVolumeName(spec.slug)}:/data`,
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=16m",
      "--log-driver",
      "json-file",
      "--log-opt",
      "max-size=5m",
      "--log-opt",
      "max-file=2",
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
      // teto por mensagem em MEGABYTES inteiros (Mailpit v1.30+): com o limite de mensagens, limita o disco da caixa
      "-e",
      `MP_MAX_MESSAGE_SIZE=${mailTestMaxMessageMb(spec.maxMessages)}`,
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
      `paas.mailtest.config=${mark}`,
      MAILPIT_IMAGE,
    ]);
    if (create.code !== 0) throw new Error(`falha ao criar ${name}: ${create.stderr.trim()}`);
    await this.attach(name, net);
    const start = await this.exec("docker", ["start", name]);
    if (start.code !== 0) throw new Error(`falha ao iniciar ${name}: ${start.stderr.trim()}`);
  }

  /** Liga o container à rede do projeto (a de leitura ele já tem desde a criação). */
  private async attach(name: string, projectNet: string): Promise<void> {
    const connect = await this.exec("docker", ["network", "connect", projectNet, name]);
    if (connect.code !== 0 && !/already exists|already connected/i.test(connect.stderr)) {
      throw new Error(`falha ao ligar ${name} à rede ${projectNet}: ${connect.stderr.trim()}`);
    }
  }

  /**
   * Remove o container e as redes do projeto (na de leitura, o painel sai antes). Uma rede só sai quando ninguém
   * mais a usa; se ainda é usada, fica para depois. `deleteData` também apaga o volume com as mensagens.
   */
  async remove(slug: string, opts: { deleteData: boolean }): Promise<{ networkLeft: string | null }> {
    const name = mailTestContainerName(slug);
    const rm = await this.exec("docker", ["rm", "-f", name]);
    if (rm.code !== 0 && !/no such container/i.test(rm.stderr)) throw new Error(`falha ao remover ${name}: ${rm.stderr.trim()}`);
    const readNet = mailTestAdminNetworkName(slug);
    // quem sobrou na rede de leitura (o painel) sai dela; sem isso o Docker não remove a rede
    const members = await this.exec("docker", ["network", "inspect", "-f", "{{range .Containers}}{{.Name}} {{end}}", readNet]);
    if (members.code === 0) {
      for (const member of members.stdout.trim().split(/\s+/).filter(Boolean)) {
        await this.exec("docker", ["network", "disconnect", "-f", readNet, member]);
      }
    }
    let networkLeft: string | null = null;
    // a rede do projeto: sai se ninguém a usa mais (o projeto ainda pode estar ligado a ela até reiniciar)
    for (const net of [mailTestNetworkName(slug), readNet]) {
      const netRm = await this.exec("docker", ["network", "rm", net]);
      if (netRm.code !== 0 && !/no such network|not found/i.test(netRm.stderr)) networkLeft ??= net;
    }
    if (opts.deleteData) {
      const volume = await this.exec("docker", ["volume", "rm", "-f", mailTestVolumeName(slug)]);
      if (volume.code !== 0 && !/no such volume/i.test(volume.stderr)) {
        throw new Error(`falha ao apagar as mensagens (${volume.stderr.trim()})`);
      }
    }
    return { networkLeft };
  }
}
