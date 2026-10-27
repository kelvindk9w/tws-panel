/**
 * mail-test-service.ts — caixa de teste de e-mail por projeto (Mailpit).
 *
 * Com a opção ligada, o SMTP do projeto aponta para um Mailpit dedicado (container do painel, rede
 * interna sem saída, sem porta publicada) e nenhuma mensagem chega a destinatário real. O dono lê
 * as mensagens pelo painel: este serviço é o único que fala com a API do Mailpit.
 *
 * Regras que importam:
 *  - FALHA FECHADA: se o Mailpit não sobe no deploy, o deploy falha. Nunca cai no servidor de
 *    e-mail real "para não parar" — esse é exatamente o envio que a opção existe para impedir.
 *  - Desligar pergunta o destino das mensagens (`deleteMessages` obrigatório): o container sai
 *    sempre; o volume só se a pessoa pediu.
 *  - Auditoria de ligar/alterar/desligar/apagar (nunca o conteúdo das mensagens).
 *  - O estado (senhas geradas incluídas) fica em data/mail-test.json, 0600. As mensagens ficam em
 *    volume Docker do projeto, fora dos dados do painel: não entram em backup nenhum.
 */
import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  MAILTEST_DEFAULT_MAX_AGE_DAYS,
  MAILTEST_DEFAULT_MAX_MESSAGES,
  MAILTEST_HTTP_PORT,
  MAILTEST_MAX_AGE_DAYS_RANGE,
  MAILTEST_MAX_MESSAGES_RANGE,
  MAILTEST_SMTP_PORT,
  mailTestContainerName,
  mailTestNetworkName,
  type MailTestListResponse,
  type MailTestUpdateRequest,
  type MailTestView,
  type Project,
} from "@paas/core";
import { JsonFile } from "./json-file.js";
import { httpError } from "./http-error.js";
import { MailpitClient } from "./mail-test-client.js";
import type { MailTestContainerSpec } from "./mail-test-docker.js";
import type { MailTestProvider } from "./deploy-service.js";

/** O que o serviço usa do Docker (MailTestDocker, ou um dublê nos testes). */
export interface MailTestDockerLike {
  connectPanel(panelContainer: string): Promise<void>;
  status(slug: string): Promise<{ installed: boolean; running: boolean }>;
  address(slug: string): Promise<string | null>;
  ensure(spec: MailTestContainerSpec): Promise<void>;
  remove(slug: string, opts: { deleteData: boolean }): Promise<void>;
}

interface StoredBox {
  enabled: boolean;
  maxMessages: number;
  maxAgeDays: number;
  /** Senha de SMTP que o app recebe (forte e própria do projeto; o Mailpit aceita qualquer uma). */
  smtpPassword: string;
  /** Senha da API/interface do Mailpit (só o painel a usa). */
  uiPassword: string;
  /** O que o último deploy/reinício usou: o app só sabe da mudança depois de um deles. */
  applied: boolean | null;
  changedAt: string;
}

interface StoredFile {
  projects: Record<string, StoredBox>;
}

export interface MailTestAudit {
  record(input: { actor?: string; action: string; target?: string | null; detail: string }): Promise<unknown>;
}

export interface MailTestServiceOptions {
  dataDir: string;
  docker: MailTestDockerLike;
  /** Container do próprio painel (entra na rede de leitura). */
  panelContainer: string;
  /** Variáveis do projeto que a caixa redireciona (para a tela). */
  redirected: (projectId: string) => Promise<string[]>;
  audit?: MailTestAudit;
  now?: () => number;
  /** Cliente do Mailpit (dublê nos testes). */
  createClient?: (target: { baseUrl: string; user: string; password: string }) => MailpitClient;
}

const UI_USER = "panel";
const ADDRESS_TTL_MS = 30_000;

const secret = (): string => randomBytes(18).toString("base64url");

function inRange(value: number, range: { min: number; max: number }): boolean {
  return Number.isInteger(value) && value >= range.min && value <= range.max;
}

/** O projeto tem containers rodando com o SMTP de antes? (site estático não envia e-mail.) */
function runsApp(project: Project): boolean {
  const type = project.detection?.type;
  if (type === "static" || type === "static-node") return false;
  return project.lastDeployStatus === "success" || (project.deployedSource ?? null) !== null;
}

export class MailTestService implements MailTestProvider {
  private readonly store: JsonFile<StoredFile>;
  private readonly createClient: NonNullable<MailTestServiceOptions["createClient"]>;
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();
  private panelReady: Promise<void> | null = null;
  private readonly addresses = new Map<string, { ip: string; at: number }>();

  constructor(private readonly opts: MailTestServiceOptions) {
    this.store = new JsonFile<StoredFile>(path.join(opts.dataDir, "mail-test.json"), {
      empty: () => ({ projects: {} }),
      parse: (value) =>
        typeof value === "object" && value !== null && typeof (value as StoredFile).projects === "object" && (value as StoredFile).projects !== null
          ? (value as StoredFile)
          : null,
    });
    this.createClient = opts.createClient ?? ((t) => new MailpitClient(t));
    this.now = opts.now ?? Date.now;
  }

  /** Uma alteração de cada vez (ligar, desligar, subir no deploy). */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async box(projectId: string): Promise<StoredBox | undefined> {
    return (await this.store.read()).projects[projectId];
  }

  private spec(project: Project, box: StoredBox): MailTestContainerSpec {
    return { slug: project.slug, maxMessages: box.maxMessages, maxAgeDays: box.maxAgeDays, uiUser: UI_USER, uiPassword: box.uiPassword };
  }

  private async connectPanel(): Promise<void> {
    this.panelReady ??= this.opts.docker.connectPanel(this.opts.panelContainer).catch((err: unknown) => {
      this.panelReady = null;
      throw err;
    });
    await this.panelReady;
  }

  // -------------------------------------------------------------------------
  // O que o deploy usa
  // -------------------------------------------------------------------------

  async active(project: Project): Promise<{ host: string; password: string } | null> {
    const box = await this.box(project.id);
    return box?.enabled ? { host: mailTestContainerName(project.slug), password: box.smtpPassword } : null;
  }

  /**
   * Deploy/reinício: sobe o Mailpit e devolve a rede dele. Qualquer falha SOBE (o deploy falha);
   * registra o que este deploy usou, para a tela saber quando o app ainda tem o SMTP antigo.
   */
  prepare(project: Project): Promise<{ network: string } | null> {
    return this.serialize(async () => {
      const box = await this.box(project.id);
      if (!box?.enabled) {
        if (box && box.applied !== false) await this.mark(project.id, false);
        return null;
      }
      try {
        await this.connectPanel();
        await this.opts.docker.ensure(this.spec(project, box));
      } catch (err) {
        throw httpError(
          502,
          "mail_test_unavailable",
          `A caixa de teste de e-mail não subiu (${err instanceof Error ? err.message : String(err)}). O deploy foi interrompido para o e-mail não sair para os destinatários reais.`,
        );
      }
      if (box.applied !== true) await this.mark(project.id, true);
      return { network: mailTestNetworkName(project.slug) };
    });
  }

  private async mark(projectId: string, applied: boolean): Promise<void> {
    await this.store.update((file) => {
      const box = file.projects[projectId];
      return box ? { projects: { ...file.projects, [projectId]: { ...box, applied } } } : file;
    });
  }

  /** Projeto removido: container, rede, volume e registro saem. */
  removed(project: Project): Promise<void> {
    return this.serialize(async () => {
      await this.opts.docker.remove(project.slug, { deleteData: true });
      this.addresses.delete(project.id);
      await this.store.update((file) => {
        if (!file.projects[project.id]) return file;
        const { [project.id]: _gone, ...rest } = file.projects;
        return { projects: rest };
      });
    });
  }

  // -------------------------------------------------------------------------
  // A tela
  // -------------------------------------------------------------------------

  async view(project: Project): Promise<MailTestView> {
    const box = await this.box(project.id);
    const enabled = box?.enabled === true;
    const settings = {
      enabled,
      maxMessages: box?.maxMessages ?? MAILTEST_DEFAULT_MAX_MESSAGES,
      maxAgeDays: box?.maxAgeDays ?? MAILTEST_DEFAULT_MAX_AGE_DAYS,
    };
    let container: MailTestView["container"] = "off";
    let messages: number | null = null;
    let unread: number | null = null;
    let problem: string | null = null;
    if (enabled) {
      const status = await this.opts.docker.status(project.slug).catch(() => null);
      container = status === null ? "missing" : status.running ? "running" : status.installed ? "stopped" : "missing";
      if (container === "running") {
        try {
          const counts = await (await this.clientFor(project, box!)).counts();
          messages = counts.total;
          unread = counts.unread;
        } catch (err) {
          problem = err instanceof Error ? err.message : String(err);
        }
      } else {
        problem =
          container === "stopped"
            ? "A caixa de teste está parada. Salve de novo para iniciá-la."
            : "O container da caixa de teste não existe (o painel foi restaurado ou ele foi removido). Salve de novo para recriá-lo.";
      }
    }
    return {
      enabled,
      settings,
      container,
      smtpHost: mailTestContainerName(project.slug),
      smtpPort: MAILTEST_SMTP_PORT,
      redirectedVariables: enabled ? await this.opts.redirected(project.id).catch(() => []) : [],
      needsRestart: runsApp(project) && (box?.applied ?? false) !== enabled,
      messages,
      unread,
      problem,
    };
  }

  /** Liga, altera a retenção ou desliga. */
  update(project: Project, req: MailTestUpdateRequest, actor?: string): Promise<MailTestView> {
    return this.serialize(async () => {
      const existing = await this.box(project.id);
      const maxMessages = req.maxMessages ?? existing?.maxMessages ?? MAILTEST_DEFAULT_MAX_MESSAGES;
      const maxAgeDays = req.maxAgeDays ?? existing?.maxAgeDays ?? MAILTEST_DEFAULT_MAX_AGE_DAYS;
      if (!inRange(maxMessages, MAILTEST_MAX_MESSAGES_RANGE)) {
        throw httpError(400, "invalid_max_messages", `O limite de mensagens deve ser de ${MAILTEST_MAX_MESSAGES_RANGE.min} a ${MAILTEST_MAX_MESSAGES_RANGE.max}.`);
      }
      if (!inRange(maxAgeDays, MAILTEST_MAX_AGE_DAYS_RANGE)) {
        throw httpError(400, "invalid_max_age", `A retenção deve ser de ${MAILTEST_MAX_AGE_DAYS_RANGE.min} a ${MAILTEST_MAX_AGE_DAYS_RANGE.max} dias.`);
      }
      const record = async (action: string, detail: string): Promise<void> => {
        await this.opts.audit?.record({ ...(actor ? { actor } : {}), action, target: project.slug, detail });
      };

      if (!req.enabled) {
        if (typeof req.deleteMessages !== "boolean") {
          throw httpError(400, "delete_choice_required", "Diga se as mensagens da caixa de teste devem ser apagadas ao desligar.");
        }
        try {
          await this.opts.docker.remove(project.slug, { deleteData: req.deleteMessages });
        } catch (err) {
          throw httpError(502, "mail_test_docker", `Não foi possível desligar a caixa de teste: ${err instanceof Error ? err.message : String(err)}`);
        }
        this.addresses.delete(project.id);
        if (existing) await this.save(project.id, { ...existing, enabled: false, changedAt: new Date(this.now()).toISOString() });
        await record(
          "mailtest.disabled",
          `Caixa de teste de e-mail de "${project.name}" desligada; o e-mail volta ao normal no próximo deploy ou reinício. Mensagens ${req.deleteMessages ? "apagadas" : "mantidas"}.`,
        );
        return this.view(project);
      }

      const box: StoredBox = {
        enabled: true,
        maxMessages,
        maxAgeDays,
        smtpPassword: existing?.smtpPassword ?? secret(),
        uiPassword: existing?.uiPassword ?? secret(),
        applied: existing?.applied ?? null,
        changedAt: new Date(this.now()).toISOString(),
      };
      try {
        await this.connectPanel();
        await this.opts.docker.ensure(this.spec(project, box));
      } catch (err) {
        throw httpError(502, "mail_test_docker", `Não foi possível iniciar a caixa de teste: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.addresses.delete(project.id);
      await this.save(project.id, box);
      await record(
        existing?.enabled ? "mailtest.updated" : "mailtest.enabled",
        existing?.enabled
          ? `Retenção da caixa de teste de "${project.name}" alterada: ${maxMessages} mensagens, ${maxAgeDays} dia(s).`
          : `Caixa de teste de e-mail de "${project.name}" ligada (${maxMessages} mensagens, ${maxAgeDays} dia(s)); o SMTP do projeto passa a ir para ela no próximo deploy ou reinício.`,
      );
      return this.view(project);
    });
  }

  private async save(projectId: string, box: StoredBox): Promise<void> {
    await this.store.update((file) => ({ projects: { ...file.projects, [projectId]: box } }));
  }

  // -------------------------------------------------------------------------
  // Mensagens
  // -------------------------------------------------------------------------

  private async clientFor(project: Project, box: StoredBox): Promise<MailpitClient> {
    await this.connectPanel().catch(() => undefined);
    let cached = this.addresses.get(project.id);
    if (!cached || this.now() - cached.at > ADDRESS_TTL_MS) {
      const ip = await this.opts.docker.address(project.slug);
      if (!ip) {
        throw httpError(502, "mail_test_unreachable", "O painel não encontrou a caixa de teste na rede interna. Salve a opção de novo para recriá-la.");
      }
      cached = { ip, at: this.now() };
      this.addresses.set(project.id, cached);
    }
    return this.createClient({ baseUrl: `http://${cached.ip}:${MAILTEST_HTTP_PORT}`, user: UI_USER, password: box.uiPassword });
  }

  private async client(project: Project): Promise<MailpitClient> {
    const box = await this.box(project.id);
    if (!box?.enabled) throw httpError(409, "mail_test_off", "A caixa de teste de e-mail está desligada neste projeto.");
    return this.clientFor(project, box);
  }

  /** Depois de uma falha de rede o IP guardado pode ser de um container antigo. */
  private async withClient<T>(project: Project, fn: (c: MailpitClient) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.client(project));
    } catch (err) {
      if ((err as { code?: string }).code === "mail_test_unreachable") this.addresses.delete(project.id);
      throw err;
    }
  }

  list(project: Project, start: number, limit: number): Promise<MailTestListResponse> {
    return this.withClient(project, (c) => c.list(start, limit));
  }

  message(project: Project, id: string): ReturnType<MailpitClient["message"]> {
    return this.withClient(project, (c) => c.message(id));
  }

  part(project: Project, id: string, partId: string): ReturnType<MailpitClient["part"]> {
    return this.withClient(project, (c) => c.part(id, partId));
  }

  async deleteMessage(project: Project, id: string, actor?: string): Promise<void> {
    await this.withClient(project, (c) => c.remove([id]));
    await this.opts.audit?.record({
      ...(actor ? { actor } : {}),
      action: "mailtest.message_deleted",
      target: project.slug,
      detail: `Uma mensagem da caixa de teste de "${project.name}" foi apagada.`,
    });
  }

  async clear(project: Project, actor?: string): Promise<void> {
    const total = await this.withClient(project, async (c) => {
      const { total: n } = await c.counts();
      await c.remove();
      return n;
    });
    await this.opts.audit?.record({
      ...(actor ? { actor } : {}),
      action: "mailtest.cleared",
      target: project.slug,
      detail: `A caixa de teste de "${project.name}" foi esvaziada (${total} mensagem(ns)).`,
    });
  }
}
