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
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import {
  MAILTEST_DEFAULT_MAX_AGE_DAYS,
  MAILTEST_DEFAULT_MAX_MESSAGES,
  MAILTEST_DISK_BUDGET_BYTES,
  MAILTEST_HTTP_PORT,
  MAILTEST_MAX_AGE_DAYS_RANGE,
  MAILTEST_MAX_MESSAGES_RANGE,
  MAILTEST_SMTP_PORT,
  MAILTEST_VERSION_OFF,
  mailTestContainerName,
  mailTestEnv,
  mailTestMaxMessageBytes,
  mailTestNetworkName,
  type MailTestListResponse,
  type MailTestUncontrolled,
  type MailTestUpdateRequest,
  type MailTestView,
  type Project,
} from "@paas/core";
import { JsonFile } from "./json-file.js";
import { httpError } from "./http-error.js";
import { MailpitClient } from "./mail-test-client.js";
import type { MailTestContainerSpec } from "./mail-test-docker.js";
import type { MailTestProvider, MailTestSnapshot } from "./deploy-service.js";

/** O que o serviço usa do Docker (MailTestDocker, ou um dublê nos testes). */
export interface MailTestDockerLike {
  connectPanel(slug: string, panelContainer: string): Promise<void>;
  status(slug: string): Promise<{ installed: boolean; running: boolean }>;
  address(slug: string): Promise<string | null>;
  ensure(spec: MailTestContainerSpec): Promise<void>;
  remove(slug: string, opts: { deleteData: boolean }): Promise<{ networkLeft: string | null }>;
}

interface StoredBox {
  enabled: boolean;
  maxMessages: number;
  maxAgeDays: number;
  /** Senha de SMTP que o app recebe (forte e própria do projeto; o Mailpit aceita qualquer uma). */
  smtpPassword: string;
  /** Senha da API/interface do Mailpit (só o painel a usa). */
  uiPassword: string;
  /**
   * Versão do ambiente de e-mail com que os containers do app foram recriados pela última vez (hash das
   * variáveis, ou "off"). Só um deploy/reinício que TERMINOU bem a grava: preparar a rede ou religar containers
   * antigos não muda o ambiente deles.
   */
  appliedVersion: string | null;
  /** Escolha da última vez que a caixa foi desligada: apagar também o volume? Vale quando o Mailpit sai de vez no reinício. */
  deleteOnOff?: boolean;
  changedAt: string;
}

interface StoredFile {
  projects: Record<string, StoredBox>;
  /**
   * Sobras de projetos apagados cuja remoção no Docker falhou (container, rede ou volume): só o slug e o motivo, sem
   * senhas. São limpas na próxima oportunidade (retryLeftovers).
   */
  leftovers?: Record<string, { at: string; reason: string }>;
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
  /** Variáveis de e-mail do projeto que o painel não controla (para a tela avisar). */
  uncontrolled?: (project: Project) => Promise<MailTestUncontrolled[]>;
  audit?: MailTestAudit;
  now?: () => number;
  /** Cliente do Mailpit (dublê nos testes). */
  createClient?: (target: { baseUrl: string; user: string; password: string }) => MailpitClient;
}

const UI_USER = "panel";
const ADDRESS_TTL_MS = 30_000;

/** Versão do ambiente de e-mail que o app recebe: muda com a senha, o host ou o conjunto de variáveis. */
export function mailTestVersion(target: { host: string; password: string } | null): string {
  if (!target) return MAILTEST_VERSION_OFF;
  const text = JSON.stringify(Object.entries(mailTestEnv(target)).sort(([a], [b]) => (a < b ? -1 : 1)));
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

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
  private readonly panelReady = new Map<string, Promise<void>>();
  /** Último motivo de o painel não ter entrado na rede de leitura de um projeto (a tela mostra junto do erro de leitura). */
  private readonly panelError = new Map<string, string>();
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

  private async connectPanel(slug: string): Promise<void> {
    let ready = this.panelReady.get(slug);
    if (!ready) {
      ready = this.opts.docker.connectPanel(slug, this.opts.panelContainer).catch((err: unknown) => {
        this.panelReady.delete(slug);
        throw err;
      });
      this.panelReady.set(slug, ready);
    }
    await ready;
  }

  /** Remove o Mailpit/redes (e o volume, se pedido) e ESQUECE a conexão do painel: religar reconecta à rede recriada. */
  private async removeBox(slug: string, opts: { deleteData: boolean }): Promise<{ networkLeft: string | null }> {
    try {
      return await this.opts.docker.remove(slug, opts);
    } finally {
      this.panelReady.delete(slug);
    }
  }

  /**
   * Antes de criar uma caixa num slug que tem sobra anotada (projeto apagado cuja remoção falhou), apaga a sobra:
   * container, volume e redes. Nunca reaproveita o volume de um projeto apagado; se não conseguir, a caixa não sobe.
   */
  private async purgeLeftover(slug: string): Promise<void> {
    if (!((await this.store.read()).leftovers ?? {})[slug]) return;
    const { networkLeft } = await this.removeBox(slug, { deleteData: true });
    if (networkLeft) throw new Error(`a sobra do projeto apagado ainda usa a rede ${networkLeft}`);
    await this.store.update((file) => {
      const { [slug]: _gone, ...rest } = file.leftovers ?? {};
      return { ...file, leftovers: rest };
    });
  }

  /**
   * Tenta de novo a limpeza das sobras de projetos apagados (menos a do slug em uso agora, que purgeLeftover trata).
   * Falha de uma sobra não derruba nada; ela fica registrada para a próxima vez.
   */
  private async retryLeftovers(inUse: string): Promise<void> {
    const left = (await this.store.read()).leftovers ?? {};
    for (const slug of Object.keys(left)) {
      if (slug === inUse) continue; // essa é tratada (e confirmada) por purgeLeftover antes de criar a caixa
      let reason: string | null = null;
      try {
        const { networkLeft } = await this.removeBox(slug, { deleteData: true });
        if (networkLeft) reason = `a rede ${networkLeft} não saiu`;
      } catch (err) {
        reason = err instanceof Error ? err.message : String(err);
      }
      await this.store.update((file) => {
        const { [slug]: _old, ...rest } = file.leftovers ?? {};
        return { ...file, leftovers: reason !== null ? { ...rest, [slug]: { at: left[slug]!.at, reason } } : rest };
      });
    }
  }

  /** Slugs com sobra registrada (limpeza posterior pendente). */
  async leftoverSlugs(): Promise<string[]> {
    return Object.keys((await this.store.read()).leftovers ?? {});
  }

  /**
   * O que falta para o app que está no ar acompanhar a caixa: "on" = ligada, mas os containers ainda enviam e-mail
   * real; "off" = desligada, mas os containers ainda apontam para a caixa (os envios falham); null = em dia (ou sem
   * app rodando: site estático, projeto nunca publicado).
   */
  async pending(project: Project): Promise<"on" | "off" | null> {
    const box = await this.box(project.id);
    if (!runsApp(project)) return null;
    const applied = box?.appliedVersion ?? MAILTEST_VERSION_OFF;
    const wanted = box?.enabled ? mailTestVersion({ host: mailTestContainerName(project.slug), password: box.smtpPassword }) : MAILTEST_VERSION_OFF;
    if (applied === wanted) return null;
    return box?.enabled ? "on" : "off";
  }

  // -------------------------------------------------------------------------
  // O que o deploy usa
  // -------------------------------------------------------------------------

  async active(project: Project): Promise<{ host: string; password: string } | null> {
    const box = await this.box(project.id);
    return box?.enabled ? { host: mailTestContainerName(project.slug), password: box.smtpPassword } : null;
  }

  /**
   * UMA fotografia do estado, tirada no começo de um deploy/reinício: o ambiente do app, a rede e o registro de
   * "aplicado" usam todos esta, mesmo que alguém ligue ou desligue a caixa no meio de um build de minutos.
   */
  async snapshot(project: Project): Promise<MailTestSnapshot> {
    const box = await this.active(project);
    return { version: mailTestVersion(box), box };
  }

  /**
   * Deploy/reinício: sobe o Mailpit e devolve a rede dele, de acordo com a fotografia do deploy. Qualquer falha
   * SOBE (o deploy falha, antes de mexer no que está no ar). Sem fotografia (religar containers que já rodam, no boot
   * do painel), vale o ambiente que os containers TÊM, isto é, o último aplicado, e não o que está ligado agora.
   * Esta função não grava "aplicado": só um deploy que terminou bem o faz (applied).
   */
  prepare(project: Project, snapshot: MailTestSnapshot | null): Promise<{ network: string } | null> {
    return this.serialize(async () => {
      const box = await this.box(project.id);
      const wanted = snapshot ? snapshot.box !== null : (box?.appliedVersion ?? MAILTEST_VERSION_OFF) !== MAILTEST_VERSION_OFF;
      if (!wanted) return null;
      if (!box) {
        throw httpError(502, "mail_test_unavailable", "A caixa de teste de e-mail deste projeto não existe mais. O deploy foi interrompido para o e-mail não sair para os destinatários reais.");
      }
      // religar containers antigos com a caixa já desligada: só a rede (o Mailpit foi removido de propósito)
      if (!snapshot && !box.enabled) return { network: mailTestNetworkName(project.slug) };
      // a caixa foi DESLIGADA depois da fotografia deste deploy: recriar o Mailpit agora o deixaria órfão (e o volume
      // voltaria contra a escolha "Apagar"). O deploy para; ao repetir, vale a escolha de agora.
      if (snapshot && !box.enabled) {
        throw httpError(409, "mail_test_changed", "A caixa de teste de e-mail foi desligada durante este deploy. Rode o deploy de novo para valer a escolha atual.");
      }
      try {
        await this.retryLeftovers(project.slug).catch(() => undefined);
        await this.purgeLeftover(project.slug);
        await this.opts.docker.ensure(this.spec(project, box));
      } catch (err) {
        throw httpError(
          502,
          "mail_test_unavailable",
          `A caixa de teste de e-mail não subiu (${err instanceof Error ? err.message : String(err)}). O deploy foi interrompido para o e-mail não sair para os destinatários reais.`,
        );
      }
      // O painel entrar na rede de leitura é só para LER as mensagens: se falhar, o deploy segue (o que importa é o
      // redirecionamento do SMTP) e a tela da caixa mostra o erro de leitura, com a opção de tentar de novo.
      await this.connectPanel(project.slug).catch(() => undefined);
      return { network: mailTestNetworkName(project.slug) };
    });
  }

  /**
   * O deploy/reinício terminou bem com o ambiente da fotografia: agora sim os containers têm essa versão.
   * Voltando ao e-mail normal, o Mailpit que sobrou (caixa desligada no meio do deploy) sai.
   */
  applied(project: Project, version: string): Promise<void> {
    return this.serialize(async () => {
      const box = await this.box(project.id);
      if (!box) return;
      if ((box.appliedVersion ?? MAILTEST_VERSION_OFF) !== version) await this.store.update((file) => {
        const current = file.projects[project.id];
        return current ? { projects: { ...file.projects, [project.id]: { ...current, appliedVersion: version } } } : file;
      });
      // volta ao e-mail normal com a caixa desligada: o Mailpit sai de vez, e o volume segue a escolha de quando desligou
      if (version === MAILTEST_VERSION_OFF && !box.enabled) {
        await this.removeBox(project.slug, { deleteData: box.deleteOnOff === true }).catch(() => undefined);
      }
    });
  }

  /** Projeto removido: container, rede, volume e registro saem. */
  removed(project: Project): Promise<void> {
    return this.serialize(async () => {
      let networkLeft: string | null = null;
      let failure: string | null = null;
      try {
        ({ networkLeft } = await this.removeBox(project.slug, { deleteData: true }));
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
      }
      this.addresses.delete(project.id);
      // O registro com as senhas SAI sempre, mesmo que o Docker tenha falhado; o que sobrou (sem senha) fica anotado
      // para a limpeza posterior.
      await this.store.update((file) => {
        const { [project.id]: _gone, ...rest } = file.projects;
        const leftovers = { ...(file.leftovers ?? {}) };
        if (failure !== null || networkLeft) leftovers[project.slug] = { at: new Date(this.now()).toISOString(), reason: failure ?? `a rede ${networkLeft} não saiu` };
        return { ...file, projects: rest, ...(Object.keys(leftovers).length > 0 ? { leftovers } : {}) };
      });
      if (failure !== null) throw new Error(`${failure} (as senhas da caixa foram apagadas; o que sobrou no Docker será limpo na próxima oportunidade)`);
      // a rede do projeto que não saiu fica órfã: quem remove o projeto precisa saber (vai para o log)
      if (networkLeft) throw new Error(`a rede ${networkLeft} não pôde ser removida (remova com: docker network rm ${networkLeft})`);
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
    let databaseBytes: number | null = null;
    if (enabled) {
      const status = await this.opts.docker.status(project.slug).catch(() => null);
      container = status === null ? "missing" : status.running ? "running" : status.installed ? "stopped" : "missing";
      if (container === "running") {
        try {
          const client = await this.clientFor(project, box!);
          const counts = await client.counts();
          messages = counts.total;
          unread = counts.unread;
          databaseBytes = await client.databaseSize().catch(() => null);
        } catch (err) {
          const why = this.panelError.get(project.slug);
          problem = (err instanceof Error ? err.message : String(err)) + (why ? ` (O painel não conseguiu entrar na rede de leitura da caixa: ${why})` : "");
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
      // falta reiniciar quando os containers foram recriados com um ambiente de e-mail diferente do desejado agora
      needsRestart: (await this.pending(project)) !== null,
      maxMessageBytes: mailTestMaxMessageBytes(settings.maxMessages),
      diskBudgetBytes: MAILTEST_DISK_BUDGET_BYTES,
      databaseBytes,
      messages,
      unread,
      problem,
      uncontrolled: enabled ? await (this.opts.uncontrolled?.(project) ?? Promise.resolve([])).catch(() => []) : [],
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
          await this.removeBox(project.slug, { deleteData: req.deleteMessages });
        } catch (err) {
          throw httpError(502, "mail_test_docker", `Não foi possível desligar a caixa de teste: ${err instanceof Error ? err.message : String(err)}`);
        }
        this.addresses.delete(project.id);
        if (existing) await this.save(project.id, { ...existing, enabled: false, deleteOnOff: req.deleteMessages, changedAt: new Date(this.now()).toISOString() });
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
        appliedVersion: existing?.appliedVersion ?? null,
        changedAt: new Date(this.now()).toISOString(),
      };
      try {
        await this.retryLeftovers(project.slug).catch(() => undefined);
        await this.purgeLeftover(project.slug);
        await this.opts.docker.ensure(this.spec(project, box));
      } catch (err) {
        throw httpError(502, "mail_test_docker", `Não foi possível iniciar a caixa de teste: ${err instanceof Error ? err.message : String(err)}`);
      }
      await this.connectPanel(project.slug).catch(() => undefined);
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
    await this.connectPanel(project.slug).then(
      () => this.panelError.delete(project.slug),
      (err: unknown) => void this.panelError.set(project.slug, err instanceof Error ? err.message : String(err)),
    );
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
