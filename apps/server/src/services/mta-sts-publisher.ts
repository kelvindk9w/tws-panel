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
/** Teto de aquecimentos (todas as origens) por hora: cada um pode gastar uma emissão do Let's Encrypt. */
export const WARM_MAX_PER_HOUR = 10;
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
  }

  private setState(domain: string, state: MtaStsState): void {
    this.states.set(domain, state);
    this.checkedAt.set(domain, this.now());
  }

  // ---------------------------------------------------------------------------
  // Aquecimento
  // ---------------------------------------------------------------------------

  private warmsInLastHour(): number {
    const from = this.now() - 3_600_000;
    while (this.warmLog.length > 0 && (this.warmLog[0] as number) <= from) this.warmLog.shift();
    return this.warmLog.length;
  }

  /**
   * Abre a política (o que dispara a emissão do certificado). Uma só requisição por domínio por vez: quem chega
   * durante uma em andamento recebe a mesma. Devolve se a política abriu. Dentro do teto por hora, senão não pede.
   */
  private warm(domain: string): Promise<boolean> {
    const running = this.warming.get(domain);
    if (running) return running;
    if (this.warmsInLastHour() >= WARM_MAX_PER_HOUR) return Promise.resolve(false);
    this.warmLog.push(this.now());
    this.lastWarm.set(domain, this.now());
    const promise = this.deps
      .fetchPolicy(domain, WARM_TIMEOUT_MS)
      .then((policy) => policy !== null)
      .catch((err: unknown) => {
        this.log(`MTA-STS de ${domain}: o aquecimento falhou (${msg(err)}).`);
        return false;
      })
      .then((opened) => {
        if (opened) this.setState(domain, "active");
        return opened;
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
          if (current !== "active") this.setState(domain, "issuing");
          continue;
        }
        if (warms >= SWEEP_MAX_WARMS) {
          if (current === undefined) this.setState(domain, "issuing");
          continue;
        }
        warms += 1;
        const opened = await this.warm(domain);
        if (!opened) this.setState(domain, "issuing");
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

    // DNS apontando: abrir a política é o que emite o certificado. Sem apontar, só se confere se abre (hospedada fora).
    let open = false;
    let issuanceTriggered = false;
    if (dns.aOk) {
      const inFlight = this.warming.has(domain);
      const last = this.lastWarm.get(domain);
      const mayTrigger = inFlight || last === undefined || this.now() - last >= WARM_MANUAL_COOLDOWN_MS;
      if (mayTrigger) {
        issuanceTriggered = !inFlight && this.warmsInLastHour() < WARM_MAX_PER_HOUR;
        open = await Promise.race([this.warm(domain), this.wait(VERIFY_WAIT_MS).then(() => false)]);
      }
    } else {
      open = (await this.deps.fetchPolicy(domain, 5_000).catch(() => null)) !== null;
    }

    const certificate = await this.deps.certState(host).catch((): MtaStsCertState => "unknown");
    const state: MtaStsState = open ? "active" : dns.aOk ? "issuing" : "waiting_dns";
    this.setState(domain, state);

    const missing: MtaStsMissingRecord[] = [];
    if (!open && dns.aOk === false) {
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
    const progress: MtaStsProgress = {
      a: open ? true : dns.aOk,
      txt: dns.txtOk === null ? null : dns.txtOk || dns.txtGrace,
      policy: open,
    };
    return {
      ...base,
      state,
      progress,
      missing,
      idGrace: dns.txtGrace,
      published,
      issuanceTriggered,
      certificate,
      retryAfter: state === "issuing" ? VERIFY_RETRY_SECONDS : null,
    };
  }
}
