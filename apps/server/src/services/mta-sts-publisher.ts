/**
 * mta-sts-publisher.ts — a política MTA-STS de cada domínio de e-mail, do lado do painel.
 *
 * O proxy (Caddy) serve https://mta-sts.<domínio>/.well-known/mta-sts.txt com certificado sob demanda: o
 * certificado só nasce quando alguém abre a URL e o `ask` do painel autoriza (DNS apontando para a VPS, cotas
 * de emissão). Este serviço faz o painel ser esse "alguém", para ninguém precisar abrir a URL à mão:
 *
 *  - ao criar o domínio de e-mail (`begin`): confere se o nome já aponta para a VPS e, apontando, aquece a emissão
 *    com uma requisição à própria URL, depois que o proxy registrou o nome;
 *  - na subida do painel e a cada rodada periódica (`sweep`): o mesmo para os domínios que ainda não têm a política
 *    ativa, poucos por rodada e com intervalo por domínio;
 *  - no botão "Verificar" da caixa do item (`verify`): confere o A e o TXT, registra o nome no proxy se faltar, dispara
 *    a emissão se o DNS aponta e diz exatamente qual registro falta.
 *
 * O que NÃO é do painel: os registros A mta-sts.<domínio> e TXT _mta-sts.<domínio> ficam no DNS do cliente. O painel
 * não tem integração com provedor de DNS, então só consegue dizer o que criar (nome e valor, com o `id` certo).
 *
 * Cotas: nada aqui gasta cota por conta própria. A emissão passa pelo `ask`, que confere o DNS antes de gastar a
 * cota por hora, por semana e por nome. Em cima disso, há um teto de aquecimentos por hora, um intervalo entre
 * aquecimentos do mesmo domínio e um limite de verificações manuais por minuto.
 */
import {
  mtaStsProgress,
  mtaStsStateOfCheck,
  type DeliveryHealthStateResponse,
  type MailHealthCheck,
  type MtaStsMissingRecord,
  type MtaStsProgress,
  type MtaStsState,
  type MtaStsVerifyResponse,
} from "@paas/core";
import {
  inspectMtaStsDns,
  mtaStsHostFor,
  mtaStsId,
  mtaStsPolicy,
  type DnsResolverLike,
  type MtaStsCertState,
  type PlanInput,
} from "@paas/mailer";
import { httpError } from "./http-error.js";
import type { MtaStsWarmLog } from "./mail-health-ack-store.js";

/** Tempo que o aquecimento espera a política abrir (a emissão do certificado leva de segundos a minutos). */
export const WARM_TIMEOUT_MS = 30_000;
/** Quanto o botão "Verificar" espera a resposta do aquecimento antes de responder "emitindo". */
export const VERIFY_WAIT_MS = 4_000;
/** Sugestão de espera, em segundos, entre uma conferência e a seguinte enquanto emite. */
export const VERIFY_RETRY_SECONDS = 6;
/** Intervalo mínimo entre duas verificações do mesmo domínio pelo botão. */
export const VERIFY_MIN_INTERVAL_MS = 3_000;
/** No máximo isto de verificações pelo botão por minuto, somando todos os domínios. */
export const VERIFY_MAX_PER_MINUTE = 20;
/** Intervalo mínimo entre dois aquecimentos do mesmo domínio feitos pelas rotinas (criação e rodada periódica). */
export const WARM_COOLDOWN_MS = 15 * 60_000;
/** Intervalo depois de o certificado ter falhado (o Caddy já espera sozinho antes de tentar de novo). */
export const WARM_COOLDOWN_FAILED_MS = 60 * 60_000;
/** Intervalo mínimo entre dois aquecimentos pedidos pelo botão para o mesmo domínio. */
export const WARM_MANUAL_COOLDOWN_MS = 20_000;
/** Teto de aquecimentos da criação e da rodada periódica por hora: cada um pode gastar uma emissão do Let's Encrypt. */
export const WARM_MAX_PER_HOUR = 10;
/** Teto próprio do botão "Verificar" por hora (separado da rotina: clicar não esgota a cota da rodada automática). */
export const WARM_MANUAL_MAX_PER_HOUR = 10;
/** Quantos domínios uma rodada periódica aquece, no máximo. */
export const SWEEP_MAX_WARMS = 3;
/** Domínio já ativo só é conferido de novo depois deste tempo. */
export const ACTIVE_RECHECK_MS = 6 * 60 * 60_000;

export interface MtaStsPublisherDeps {
  /** Domínios de e-mail cadastrados. */
  domains(): Promise<string[]>;
  /** Dados do domínio para o plano (404 se não cadastrado). */
  planInput(domain: string): Promise<PlanInput>;
  /** O proxy consegue publicar (precisa do domínio do painel)? */
  publishing(): Promise<boolean>;
  /** O nome aponta para esta VPS? (a mesma conferência do `ask`). */
  pointsHere(host: string): Promise<boolean>;
  /** Recarrega o proxy (Caddyfile com os sites mta-sts.<domínio>). */
  refreshProxy(): Promise<void>;
  /** Abre a política em HTTPS; ao ser pedida com o DNS apontando, é o que dispara a emissão. null = não abriu. */
  fetchPolicy(domain: string, timeoutMs: number): Promise<string | null>;
  certState(host: string): Promise<MtaStsCertState>;
  resolver(): DnsResolverLike;
  isProxyIp(ip: string): boolean;
  /** Avalia o item MTA-STS pela MESMA regra da saúde e o grava no relatório guardado (ver MailHealthService.refreshMtaSts). */
  evaluate(domain: string): Promise<{ check: MailHealthCheck; state: DeliveryHealthStateResponse }>;
  /** Onde ficam os registros de aquecimento (tetos por hora e intervalos sobrevivem a reinícios). Ausente = só memória. */
  warmStore?: { load(): Promise<MtaStsWarmLog>; save(log: MtaStsWarmLog): Promise<void> };
  /** Ids de políticas anteriores ainda aceitos no TXT (ver MtaStsIdStore). */
  ids?: { observe(domain: string, currentId: string): Promise<string[]> };
  log?: (message: string) => void;
  now?: () => number;
  /** Espera (testes trocam por uma versão instantânea). */
  wait?: (ms: number) => Promise<void>;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class MtaStsPublisher {
  private readonly states = new Map<string, MtaStsState>();
  private readonly checkedAt = new Map<string, number>();
  /** Domínios cujo site o proxy já recebeu (desde a subida ou o último recarregamento). */
  private readonly registered = new Set<string>();
  private readonly lastWarm = new Map<string, number>();
  private readonly warming = new Map<string, Promise<boolean>>();
  private readonly warmLog: number[] = [];
  private readonly manualWarmLog: number[] = [];
  private loaded: Promise<void> | null = null;
  private readonly verifyAt = new Map<string, number>();
  private readonly verifyLog: number[] = [];
  private sweeping = false;

  constructor(private readonly deps: MtaStsPublisherDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private wait(ms: number): Promise<void> {
    return (this.deps.wait ?? sleep)(ms);
  }

  private log(message: string): void {
    this.deps.log?.(message);
  }

  /** Lê uma vez os registros de aquecimento guardados (os tetos por hora e os intervalos valem também após reiniciar). */
  private ensureLoaded(): Promise<void> {
    this.loaded ??= (this.deps.warmStore?.load() ?? Promise.resolve(null)).then(
      (saved) => {
        if (!saved) return;
        this.warmLog.unshift(...saved.routine);
        this.manualWarmLog.unshift(...saved.manual);
        for (const [domain, at] of Object.entries(saved.last)) if (!this.lastWarm.has(domain)) this.lastWarm.set(domain, at);
      },
      (err: unknown) => this.log(`MTA-STS: registro de aquecimentos não lido (${msg(err)}).`),
    );
    return this.loaded;
  }

  private saving: Promise<void> = Promise.resolve();

  private persistWarms(): void {
    const store = this.deps.warmStore;
    if (!store) return;
    const snapshot = { routine: [...this.warmLog], manual: [...this.manualWarmLog], last: Object.fromEntries(this.lastWarm) };
    // gravações em fila, uma por vez: a última sempre vence
    this.saving = this.saving.then(() => store.save(snapshot)).catch((err: unknown) => this.log(`MTA-STS: registro de aquecimentos não gravado (${msg(err)}).`));
  }

  /** Espera as gravações pendentes do registro de aquecimentos (ao fechar o painel). */
  flush(): Promise<void> {
    return this.saving;
  }

  /** O item da saúde mudou (verificação completa ou só do item): a lista de domínios acompanha. */
  observe(domain: string, check: Pick<MailHealthCheck, "code">): void {
    this.setState(domain.toLowerCase(), mtaStsStateOfCheck(check));
  }

  /** Reavalia o item pela regra da saúde e atualiza o estado da lista. null = a avaliação falhou (estado mantido). */
  private async refreshState(domain: string): Promise<{ check: MailHealthCheck; state: DeliveryHealthStateResponse } | null> {
    try {
      const result = await this.deps.evaluate(domain);
      this.setState(domain, mtaStsStateOfCheck(result.check));
      return result;
    } catch (err) {
      this.log(`MTA-STS de ${domain}: não foi possível avaliar o item (${msg(err)}).`);
      return null;
    }
  }

  /** Último estado conhecido (undefined = ainda não conferido desde que o painel subiu). */
  state(domain: string): MtaStsState | undefined {
    return this.states.get(domain.toLowerCase());
  }

  /** O proxy recarregou com estes domínios: o site mta-sts de cada um está registrado. */
  markRegistered(domains: Iterable<string>): void {
    this.registered.clear();
    for (const d of domains) this.registered.add(d.toLowerCase());
  }

  /** Domínio removido: esquece o estado. */
  forget(domain: string): void {
    const d = domain.toLowerCase();
    for (const map of [this.states, this.checkedAt, this.lastWarm, this.warming, this.verifyAt] as Array<Map<string, unknown>>) map.delete(d);
    this.registered.delete(d);
    this.persistWarms();
  }

  private setState(domain: string, state: MtaStsState): void {
    this.states.set(domain, state);
    this.checkedAt.set(domain, this.now());
  }

  // ---------------------------------------------------------------------------
  // Aquecimento
  // ---------------------------------------------------------------------------

  private warmsInLastHour(manual = false): number {
    const log = manual ? this.manualWarmLog : this.warmLog;
    const from = this.now() - 3_600_000;
    while (log.length > 0 && (log[0] as number) <= from) log.shift();
    return log.length;
  }

  /** Quando o teto por hora do botão volta a valer (o aquecimento mais antigo sai da janela). */
  private manualLimitUntil(): string {
    return new Date((this.manualWarmLog[0] as number) + 3_600_000).toISOString();
  }

  /**
   * Abre a política (o que dispara a emissão do certificado). Uma só requisição por domínio por vez: quem chega
   * durante uma em andamento recebe a mesma. Devolve se a política abriu. Dentro do teto por hora, senão não pede.
   */
  private warm(domain: string, manual = false): Promise<boolean> {
    const running = this.warming.get(domain);
    if (running) return running;
    if (this.warmsInLastHour(manual) >= (manual ? WARM_MANUAL_MAX_PER_HOUR : WARM_MAX_PER_HOUR)) return Promise.resolve(false);
    (manual ? this.manualWarmLog : this.warmLog).push(this.now());
    this.lastWarm.set(domain, this.now());
    this.persistWarms();
    const promise = this.deps
      .fetchPolicy(domain, WARM_TIMEOUT_MS)
      .then((policy) => policy !== null)
      .catch((err: unknown) => {
        this.log(`MTA-STS de ${domain}: o aquecimento falhou (${msg(err)}).`);
        return false;
      })
      .finally(() => this.warming.delete(domain));
    this.warming.set(domain, promise);
    return promise;
  }

  // ---------------------------------------------------------------------------
  // Criação do domínio
  // ---------------------------------------------------------------------------

  /**
   * Domínio de e-mail recém-criado: a política passa a ser publicada. Responde já com o estado (aguardando DNS
   * ou emitindo); o aquecimento da emissão espera o proxy ter registrado o nome (`proxyReady`) e roda em segundo plano.
   */
  async begin(domain: string, proxyReady: Promise<unknown> = Promise.resolve()): Promise<MtaStsState> {
    const name = domain.toLowerCase();
    await this.ensureLoaded();
    if (!(await this.deps.publishing().catch(() => false))) {
      this.setState(name, "unavailable");
      return "unavailable";
    }
    const points = await this.deps.pointsHere(mtaStsHostFor(name)).catch(() => false);
    const state: MtaStsState = points ? "issuing" : "waiting_dns";
    this.setState(name, state);
    if (points) {
      void proxyReady
        .then(() => {
          this.registered.add(name);
          return this.warm(name);
        })
        .then((opened) => (opened ? this.refreshState(name) : null))
        .catch((err: unknown) => this.log(`MTA-STS de ${name}: não foi possível aquecer a emissão (${msg(err)}).`));
    }
    return state;
  }

  // ---------------------------------------------------------------------------
  // Rodada periódica
  // ---------------------------------------------------------------------------

  /**
   * Para todos os domínios que ainda não têm a política ativa: registra no proxy o que faltar e aquece a emissão dos
   * que já apontam. No máximo SWEEP_MAX_WARMS por rodada, cada domínio com o seu intervalo, e dentro do teto por hora.
   */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      await this.ensureLoaded();
      const domains = (await this.deps.domains()).map((d) => d.toLowerCase());
      if (!(await this.deps.publishing().catch(() => false))) {
        for (const d of domains) this.setState(d, "unavailable");
        return;
      }
      if (domains.some((d) => !this.registered.has(d))) {
        await this.deps.refreshProxy();
        this.markRegistered(domains);
      }
      let warms = 0;
      for (const domain of domains) {
        const current = this.states.get(domain);
        const checked = this.checkedAt.get(domain) ?? 0;
        if (current === "active" && this.now() - checked < ACTIVE_RECHECK_MS) continue;
        // A política já abre (ativa e na hora de reconferir, ou com algo a acertar no DNS ou no conteúdo): basta reavaliar o
        // item, que é barato e não pede emissão. Só "ativo" tem a pausa de 6 h; os outros são reavaliados a cada rodada.
        if (current === "active" || current === "missing_txt" || current === "attention" || current === "unverified") {
          await this.refreshState(domain);
          continue;
        }
        const points = await this.deps.pointsHere(mtaStsHostFor(domain)).catch(() => false);
        if (!points) {
          this.setState(domain, "waiting_dns");
          continue;
        }
        // DNS apontando: se o certificado já existe, a requisição abre a política sem gastar emissão; senão, emite.
        const failed = (await this.deps.certState(mtaStsHostFor(domain)).catch((): MtaStsCertState => "unknown")) === "failed";
        const last = this.lastWarm.get(domain);
        const cooldown = failed ? WARM_COOLDOWN_FAILED_MS : WARM_COOLDOWN_MS;
        if (last !== undefined && this.now() - last < cooldown) {
          this.setState(domain, "issuing");
          continue;
        }
        if (warms >= SWEEP_MAX_WARMS) {
          if (current === undefined) this.setState(domain, "issuing");
          continue;
        }
        warms += 1;
        const opened = await this.warm(domain);
        if (opened) await this.refreshState(domain);
        else this.setState(domain, "issuing");
      }
    } catch (err) {
      this.log(`MTA-STS: a rodada de publicação falhou (${msg(err)}).`);
    } finally {
      this.sweeping = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Botão "Verificar"
  // ---------------------------------------------------------------------------

  /** Limites do botão: intervalo por domínio e teto por minuto no servidor todo. */
  private admitVerify(domain: string): void {
    const last = this.verifyAt.get(domain);
    if (last !== undefined && this.now() - last < VERIFY_MIN_INTERVAL_MS) {
      const wait = Math.max(1, Math.ceil((VERIFY_MIN_INTERVAL_MS - (this.now() - last)) / 1000));
      const err = httpError(429, "mta_sts_verify_too_soon", `A verificação acabou de rodar. Espere ${wait} s.`);
      err.details = { retryAfter: wait };
      throw err;
    }
    const from = this.now() - 60_000;
    while (this.verifyLog.length > 0 && (this.verifyLog[0] as number) <= from) this.verifyLog.shift();
    if (this.verifyLog.length >= VERIFY_MAX_PER_MINUTE) {
      const wait = Math.max(1, Math.ceil((((this.verifyLog[0] as number) + 60_000) - this.now()) / 1000));
      const err = httpError(429, "mta_sts_verify_busy", `Muitas verificações de MTA-STS em pouco tempo neste servidor. Espere ${wait} s.`);
      err.details = { retryAfter: wait };
      throw err;
    }
    this.verifyAt.set(domain, this.now());
    this.verifyLog.push(this.now());
  }

  /**
   * Roda só o item MTA-STS agora: consulta o A e o TXT, registra o nome no proxy se faltava, dispara a emissão do
   * certificado se o DNS aponta e diz o que falta (só o que falta, com o valor certo do `id`).
   */
  async verify(rawDomain: string): Promise<MtaStsVerifyResponse> {
    const domain = rawDomain.trim().toLowerCase().replace(/\.+$/, "");
    const plan = await this.deps.planInput(domain); // 404 se o domínio não está cadastrado
    this.admitVerify(domain);
    await this.ensureLoaded();
    const host = mtaStsHostFor(domain);
    const expectedId = mtaStsId(mtaStsPolicy(plan.mailHostname));
    const base = { domain, checkedAt: new Date(this.now()).toISOString() };

    if (!(await this.deps.publishing().catch(() => false))) {
      this.setState(domain, "unavailable");
      return {
        ...base,
        state: "unavailable",
        progress: { a: null, txt: null, policy: null },
        missing: [],
        idGrace: false,
        published: false,
        issuanceTriggered: false,
        certificate: "unknown",
        retryAfter: null,
        check: null,
        health: null,
        warmLimitUntil: null,
      };
    }

    // Falta só a publicação do lado do painel: cria na hora.
    let published = false;
    if (!this.registered.has(domain)) {
      await this.deps.refreshProxy();
      this.markRegistered([...this.registered, domain]);
      published = true;
    }

    const accepted = await (this.deps.ids?.observe(domain, expectedId) ?? Promise.resolve([])).catch((): string[] => []);
    const dns = await inspectMtaStsDns({
      domain,
      mailHostname: plan.mailHostname,
      serverIp: plan.serverIp,
      resolver: this.deps.resolver(),
      isProxyIp: (ip) => this.deps.isProxyIp(ip),
      acceptedIds: accepted,
    });

    // DNS apontando: abrir a política é o que emite o certificado (com o teto próprio do botão). Com o certificado já
    // válido, abrir não emite nada: basta avaliar. Sem apontar, só se avalia (a política pode estar hospedada fora).
    const certificate = await this.deps.certState(host).catch((): MtaStsCertState => "unknown");
    let evaluate = !dns.aOk || certificate === "valid";
    let issuanceTriggered = false;
    let warmLimitUntil: string | null = null;
    if (!evaluate) {
      const inFlight = this.warming.has(domain);
      const last = this.lastWarm.get(domain);
      const mayTrigger = inFlight || last === undefined || this.now() - last >= WARM_MANUAL_COOLDOWN_MS;
      if (mayTrigger) {
        if (!inFlight && this.warmsInLastHour(true) >= WARM_MANUAL_MAX_PER_HOUR) {
          warmLimitUntil = this.manualLimitUntil();
        } else {
          issuanceTriggered = !inFlight;
          const warmed = this.warm(domain, true);
          const early = await Promise.race([warmed, this.wait(VERIFY_WAIT_MS).then(() => null)]);
          // Demorou além da espera curta: a resposta sai "emitindo" e, quando a política abrir, o estado é reavaliado sozinho.
          if (early === null) void warmed.then((opened) => (opened ? this.refreshState(domain) : null));
          evaluate = early === true;
        }
      }
    }

    // O item é avaliado pela MESMA regra da saúde (MX reais, enforce, política inválida, TXT indisponível, id aceito) e
    // gravado no relatório: o estado da lista e o item da caixa nunca divergem.
    const evaluated = evaluate ? await this.refreshState(domain) : null;
    const state: MtaStsState = evaluated ? mtaStsStateOfCheck(evaluated.check) : dns.aOk ? "issuing" : "waiting_dns";
    if (!evaluated) this.setState(domain, state);
    const policyOpens = evaluated ? mtaStsProgress(evaluated.check.code).policy === true : false;

    const missing: MtaStsMissingRecord[] = [];
    if (!policyOpens && dns.aOk === false) {
      missing.push({ id: "mta_sts_a", type: "A", name: host, value: plan.serverIp });
    }
    if (dns.txtOk === false && !dns.txtGrace) {
      missing.push({
        id: "mta_sts",
        type: "TXT",
        name: `_mta-sts.${domain}`,
        value: `v=STSv1; id=${expectedId}`,
        ...(dns.txtOutdated ? { outdated: true } : {}),
      });
    }
    const progress: MtaStsProgress = evaluated
      ? mtaStsProgress(evaluated.check.code)
      : { a: dns.aOk, txt: dns.txtOk === null ? null : dns.txtOk || dns.txtGrace, policy: false };
    return {
      ...base,
      state,
      progress,
      missing,
      idGrace: evaluated ? evaluated.check.code === "id_grace" : dns.txtGrace,
      published,
      issuanceTriggered,
      certificate,
      retryAfter: state === "issuing" && warmLimitUntil === null ? VERIFY_RETRY_SECONDS : null,
      check: evaluated?.check ?? null,
      health: evaluated?.state ?? null,
      warmLimitUntil,
    };
  }
}
