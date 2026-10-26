/**
 * Caixa do MTA-STS na saúde do envio de e-mail:
 *  - política ativa: selo "Ativo", sem passos de configuração, "Detalhes" recolhido, sem "Bônus";
 *  - falta algo: só os passos do que falta, cada item com ✓/✗ e a palavra "Pronto"/"Falta";
 *  - botão "Verificar": roda só este item, acompanha a emissão do certificado (nova conferência a cada poucos
 *    segundos, até um limite), mostra exatamente o registro que falta com o valor certo do `id`, e a linha
 *    passa a "Ativo" sem esperar a verificação geral.
 * A API é simulada (fetch) e o relógio é falso.
 */
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mailHealthScope,
  type DeliveryHealthResponse,
  type DeliveryHealthStateResponse,
  type DnsPlanResponse,
  type MailHealthCheck,
  type MtaStsVerifyResponse,
} from "@paas/core";
import { CheckRow, DeliveryHealthCard, levelLabelKey } from "../src/components/mail/DeliveryHealthCard";
import { MtaStsHowTo, MTA_STS_MAX_FOLLOW_UPS } from "../src/components/mail/MtaStsHowTo";
import { setLocale } from "../src/i18n/core";

const DOMAIN = "envio.example.com";
const HOST = `mail.${DOMAIN}`;
const IP = "203.0.113.10";
const TXT = "v=STSv1; id=abc123";

const PLAN: DnsPlanResponse = {
  domain: DOMAIN,
  serverHostname: HOST,
  ptr: { ip: IP, expected: HOST },
  mtaStsPolicy: `version: STSv1\r\nmode: testing\r\nmx: ${HOST}\r\nmax_age: 86400\r\n`,
  records: [
    { id: "a", order: 1, type: "A", name: HOST, value: IP, need: "required", purpose: "a", proxied: false },
    { id: "mta_sts_a", order: 2, type: "A", name: `mta-sts.${DOMAIN}`, value: IP, need: "optional", purpose: "mta_sts_a", proxied: false },
    { id: "mta_sts", order: 3, type: "TXT", name: `_mta-sts.${DOMAIN}`, value: TXT, need: "optional", purpose: "mta_sts", proxied: false },
  ],
};

const sts = (code: string, level: MailHealthCheck["level"] = "optional", extra: Partial<MailHealthCheck> = {}): MailHealthCheck => ({
  id: "mta_sts",
  level,
  inbox: false,
  code,
  params: { host: `mta-sts.${DOMAIN}`, ip: IP, mode: code },
  ...extra,
});

const verifyResult = (over: Partial<MtaStsVerifyResponse> = {}): MtaStsVerifyResponse => ({
  domain: DOMAIN,
  checkedAt: "2026-10-26T12:00:00.000Z",
  state: "waiting_dns",
  progress: { a: false, txt: false, policy: false },
  missing: [],
  idGrace: false,
  published: false,
  issuanceTriggered: false,
  certificate: "unknown",
  retryAfter: null,
  check: null,
  health: null,
  warmLimitUntil: null,
  ...over,
});

const report = (checks: MailHealthCheck[]): DeliveryHealthResponse => ({
  domain: DOMAIN,
  checkedAt: "2026-10-26T12:00:00.000Z",
  level: "ok",
  counts: { ok: checks.filter((c) => c.level === "ok").length, warn: 0, critical: 0, optional: checks.filter((c) => c.level === "optional").length, acknowledged: 0 },
  checks,
  scopes: {
    server: { level: "ok", counts: { ok: 0, warn: 0, critical: 0, optional: 0, acknowledged: 0 } },
    domain: { level: "ok", counts: { ok: checks.length, warn: 0, critical: 0, optional: 0, acknowledged: 0 } },
  },
  inboxIssues: [],
});


/** A saúde do domínio como o servidor a devolve no "Verificar": o relatório já com o item MTA-STS reavaliado. */
const healthWith = (check: MailHealthCheck, over: Partial<DeliveryHealthResponse> = {}): DeliveryHealthStateResponse => ({
  plan: PLAN,
  report: { ...report([check]), ...over },
});

interface Call {
  url: string;
  body: string | null;
}

/** Cada chamada ao verify devolve a próxima resposta da fila (a última se repete); `Response` vira erro HTTP. */
function mockVerify(queue: Array<MtaStsVerifyResponse | Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: typeof init?.body === "string" ? init.body : null });
      const next = queue.length > 1 ? queue.shift()! : queue[0]!;
      return next instanceof Response ? next.clone() : Response.json(next);
    }),
  );
  return calls;
}

beforeEach(() => {
  setLocale("pt-BR", { persist: false });
  vi.useFakeTimers({ shouldAdvanceTime: false });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const row = () => document.querySelector('[data-check="mta_sts"]') as HTMLElement;
const open = (name: string) => fireEvent.click(within(row()).getByRole("button", { name }));
const flush = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const clickVerify = async () => {
  fireEvent.click(within(row()).getByRole("button", { name: /^Verificar/ }));
  await flush();
};

/** Como no cartão: o relatório é de quem renderiza, e o "Verificar" o substitui pelo que o servidor devolveu. */
function Live({ initial }: { initial: MailHealthCheck }) {
  const [current, setCurrent] = useState(initial);
  return (
    <ul>
      <CheckRow
        check={current}
        plan={PLAN}
        onHealth={(h) => setCurrent(h.report?.checks.find((c) => c.id === "mta_sts") ?? current)}
      />
    </ul>
  );
}
const renderLive = (check: MailHealthCheck) => render(<Live initial={check} />);

function renderRow(check: MailHealthCheck) {
  return render(
    <ul>
      <CheckRow check={check} plan={PLAN} />
    </ul>,
  );
}

describe("estado concluído: política ativa", () => {
  it("testing: selo 'Ativo' (não 'Bônus'), texto 'MTA-STS ativo em modo de teste' e nenhum passo de configuração", () => {
    renderRow(sts("testing", "ok"));
    expect(screen.getByTestId("badge-mta_sts")).toHaveTextContent("Ativo");
    expect(screen.queryByText("Bônus")).toBeNull();
    expect(screen.getByTestId("message-mta_sts")).toHaveTextContent("MTA-STS ativo em modo de teste");
    expect(row()).toHaveAttribute("data-level", "ok");
    // sem "O que fazer": o botão é "Detalhes" e começa recolhido
    expect(within(row()).queryByRole("button", { name: "O que fazer" })).toBeNull();
    const details = within(row()).getByRole("button", { name: "Detalhes" });
    expect(details).toHaveAttribute("aria-expanded", "false");
    expect(within(row()).queryByRole("region")).toBeNull();
  });

  it("os Detalhes trazem os valores para consulta, sem passos nem ✗", () => {
    renderRow(sts("testing", "ok"));
    open("Detalhes");
    const region = within(row()).getByRole("region", { name: "Detalhes do MTA-STS" });
    expect(region).toHaveTextContent(`mta-sts.${DOMAIN}`);
    expect(region).toHaveTextContent(`_mta-sts.${DOMAIN}`);
    expect(region).toHaveTextContent(TXT);
    expect(region).toHaveTextContent(`https://mta-sts.${DOMAIN}/.well-known/mta-sts.txt`);
    expect(region).toHaveTextContent("version: STSv1");
    expect(region.querySelector("[data-step]")).toBeNull();
    expect(region).not.toHaveTextContent(/nuvem CINZA/);
    expect(within(region).getByRole("button", { name: "Copiar Valor do TXT" })).toBeInTheDocument();
  });

  it("enforce também é 'Ativo'", () => {
    renderRow(sts("enforce", "ok"));
    expect(screen.getByTestId("badge-mta_sts")).toHaveTextContent("Ativo");
    expect(screen.getByTestId("message-mta_sts")).toHaveTextContent("MTA-STS ativo em modo enforce");
  });

  it("TXT com o id anterior ainda aceito: 'Ativo', com o lembrete e o valor novo para copiar", () => {
    renderRow(sts("id_grace", "info", { expected: TXT, found: ["v=STSv1; id=antigo"] }));
    expect(screen.getByTestId("badge-mta_sts")).toHaveTextContent("Ativo");
    expect(screen.getByTestId("message-mta_sts")).toHaveTextContent(/ainda tem o id anterior/);
    open("Detalhes");
    const region = within(row()).getByRole("region");
    expect(region).toHaveTextContent(/aceito por até 24 horas/);
    expect(region).toHaveTextContent(TXT);
  });

  it("em inglês: 'Active' e 'MTA-STS active in test mode'", () => {
    setLocale("en", { persist: false });
    renderRow(sts("testing", "ok"));
    expect(screen.getByTestId("badge-mta_sts")).toHaveTextContent("Active");
    expect(screen.getByTestId("message-mta_sts")).toHaveTextContent("MTA-STS active in test mode");
    expect(within(row()).getByRole("button", { name: "Details" })).toBeInTheDocument();
  });

  it("levelLabelKey: só o MTA-STS com política aberta ganha o selo 'Ativo'", () => {
    expect(levelLabelKey({ id: "mta_sts", level: "ok", code: "testing" })).toBe("mailHealth.level.active");
    expect(levelLabelKey({ id: "mta_sts", level: "info", code: "id_grace" })).toBe("mailHealth.level.active");
    expect(levelLabelKey({ id: "mta_sts", level: "optional", code: "absent" })).toBe("mailHealth.level.optional.absent");
    expect(levelLabelKey({ id: "tls_rpt", level: "ok", code: "ok" })).toBe("mailHealth.level.ok");
  });
});

describe("falta algo: só o que falta, com ✓ ou ✗ em palavras", () => {
  it.each([
    ["absent", { a: "Falta", txt: "Falta", policy: "Falta" }, ["a", "txt"]],
    ["missing_txt", { a: "Pronto", txt: "Falta", policy: "Falta" }, ["txt"]],
    ["missing_a", { a: "Falta", txt: "Pronto", policy: "Falta" }, ["a"]],
    ["a_mismatch", { a: "Falta", txt: "Pronto", policy: "Falta" }, ["a"]],
    ["a_proxied", { a: "Falta", txt: "Pronto", policy: "Falta" }, ["a"]],
    ["id_outdated", { a: "Pronto", txt: "Falta", policy: "Pronto" }, ["txt"]],
    ["cert_pending", { a: "Pronto", txt: "Pronto", policy: "Falta" }, ["policy"]],
    ["cert_failed", { a: "Pronto", txt: "Pronto", policy: "Falta" }, ["policy"]],
    ["unreachable", { a: "Pronto", txt: "Pronto", policy: "Falta" }, ["policy"]],
  ] as const)("%s", (code, words, steps) => {
    renderRow(sts(code));
    open("O que fazer");
    const region = within(row()).getByRole("region");
    for (const id of ["a", "txt", "policy"] as const) {
      expect(region.querySelector(`[data-status-row="${id}"]`), id).toHaveTextContent(words[id]);
    }
    const shown = Array.from(region.querySelectorAll("[data-step]")).map((e) => e.getAttribute("data-step"));
    expect(shown).toEqual(steps);
    // o ✗ de cada passo também é dito em palavras para quem usa leitor de tela
    for (const step of Array.from(region.querySelectorAll("[data-step]"))) expect(step).toHaveTextContent("Falta");
  });

  it("certificado que falhou diz a causa provável e manda para a página Certificados", () => {
    renderRow(sts("cert_failed"));
    open("O que fazer");
    expect(within(row()).getByRole("region")).toHaveTextContent(/A emissão do certificado falhou/);
  });

  it("TXT com o id antigo: o passo pede a troca do valor (o valor mostrado é o do plano, com o id atual)", () => {
    renderRow(sts("id_outdated", "optional", { expected: TXT, found: ["v=STSv1; id=antigo"] }));
    open("O que fazer");
    const step = row().querySelector('[data-step="txt"]')!;
    expect(step).toHaveTextContent(/com o id de uma política anterior/);
    expect(step).toHaveTextContent(TXT);
  });

  it("consulta que falhou (nada conferido): as três linhas dizem 'Não conferido' e os passos de A e TXT aparecem", () => {
    renderRow(sts("txt_unavailable", "info"));
    open("O que fazer");
    const region = within(row()).getByRole("region");
    for (const id of ["a", "txt", "policy"]) expect(region.querySelector(`[data-status-row="${id}"]`)).toHaveTextContent("Não conferido");
    expect(region.querySelector('[data-step="a"]')).not.toBeNull();
  });

  it("sem o domínio do painel continua o passo a passo próprio (sem A/TXT para criar)", () => {
    renderRow(sts("publish_unavailable"));
    open("O que fazer");
    const region = within(row()).getByRole("region");
    expect(region).toHaveTextContent(/Domínio do painel/);
    expect(row().querySelector('[data-howto="mta_sts_panel"]')).not.toBeNull();
    expect(within(row()).queryByRole("button", { name: /^Verificar/ })).toBeNull();
  });
});

describe("botão Verificar", () => {
  it("roda só este item (POST no domínio), mostra o resultado na própria caixa e não pede a verificação geral", async () => {
    const calls = mockVerify([verifyResult({ state: "waiting_dns", missing: [{ id: "mta_sts_a", type: "A", name: `mta-sts.${DOMAIN}`, value: IP }] })]);
    renderRow(sts("absent"));
    open("O que fazer");
    await clickVerify();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ url: `/api/mail/domains/${DOMAIN}/mta-sts/verify`, body: JSON.stringify({ followUp: false }) });
    const outcome = within(row()).getByTestId("mta-sts-result");
    expect(outcome).toHaveAttribute("aria-live", "polite");
    expect(outcome).toHaveTextContent(/O DNS ainda não está completo/);
    expect(outcome).toHaveTextContent(`mta-sts.${DOMAIN}`);
  });

  it("mostra exatamente o que falta, com o valor certo do id (TXT desatualizado) e botão de copiar nos passos", async () => {
    mockVerify([
      verifyResult({
        state: "issuing",
        retryAfter: null,
        progress: { a: true, txt: false, policy: false },
        missing: [{ id: "mta_sts", type: "TXT", name: `_mta-sts.${DOMAIN}`, value: "v=STSv1; id=novo999", outdated: true }],
      }),
    ]);
    renderRow(sts("cert_pending"));
    open("O que fazer");
    // antes: só a política faltava
    expect(row().querySelector('[data-step="policy"]')).not.toBeNull();
    await clickVerify();
    // depois: a verificação achou o TXT com id antigo; o passo do TXT traz o valor novo
    const step = row().querySelector('[data-step="txt"]')!;
    expect(step).toHaveTextContent("v=STSv1; id=novo999");
    expect(within(step as HTMLElement).getByRole("button", { name: "Copiar Valor do TXT" })).toBeInTheDocument();
    expect(row().querySelector('[data-missing="mta_sts"]')).toHaveTextContent(/TXT \(troque o valor atual\)/);
  });

  it("DNS completo e o certificado sendo emitido: 'emitindo…' e nova conferência a cada poucos segundos, com followUp", async () => {
    const calls = mockVerify([
      verifyResult({ state: "issuing", retryAfter: 6, issuanceTriggered: true, published: true, progress: { a: true, txt: true, policy: false } }),
      verifyResult({ state: "issuing", retryAfter: 6, progress: { a: true, txt: true, policy: false } }),
      verifyResult({ state: "active", progress: { a: true, txt: true, policy: true }, check: sts("testing", "ok"), health: healthWith(sts("testing", "ok")) }),
    ]);
    renderLive(sts("cert_pending"));
    open("O que fazer");
    await clickVerify();
    const outcome = within(row()).getByTestId("mta-sts-result");
    expect(outcome).toHaveTextContent(/Emitindo o certificado… confiro de novo em 6 s \(conferência 1 de 9\)/);
    expect(outcome).toHaveTextContent("A emissão do certificado foi disparada.");
    expect(outcome).toHaveTextContent("O painel registrou o nome no proxy agora.");
    await flush(5_900);
    expect(calls).toHaveLength(1);
    await flush(200);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toBe(JSON.stringify({ followUp: true }));
    await flush(6_100);
    expect(calls).toHaveLength(3);
    // política aberta: a linha inteira passa a "Ativo", sem passos
    expect(screen.getByTestId("badge-mta_sts")).toHaveTextContent("Ativo");
    expect(screen.getByTestId("message-mta_sts")).toHaveTextContent("MTA-STS ativo em modo de teste");
    expect(within(row()).getByTestId("mta-sts-result")).toHaveTextContent("MTA-STS ativo em modo de teste. Nada mais a fazer.");
    expect(row().querySelector("[data-step]")).toBeNull();
    // e para de conferir
    await flush(60_000);
    expect(calls).toHaveLength(3);
  });

  it("emissão que não termina: para no limite de conferências e manda verificar de novo depois", async () => {
    const calls = mockVerify([verifyResult({ state: "issuing", retryAfter: 6, certificate: "failed", progress: { a: true, txt: true, policy: false } })]);
    renderLive(sts("cert_pending"));
    open("O que fazer");
    await clickVerify();
    for (let i = 0; i < 20; i += 1) await flush(6_000);
    expect(calls).toHaveLength(MTA_STS_MAX_FOLLOW_UPS + 1);
    const outcome = within(row()).getByTestId("mta-sts-result");
    expect(outcome).toHaveTextContent(/ainda está sendo emitido/);
    expect(outcome).toHaveTextContent(/registra falha na emissão/);
    expect(outcome).not.toHaveTextContent("Emitindo o certificado…");
  });

  it("clicar de novo recomeça a contagem e cancela a conferência agendada", async () => {
    const calls = mockVerify([verifyResult({ state: "issuing", retryAfter: 6, progress: { a: true, txt: true, policy: false } })]);
    renderRow(sts("cert_pending"));
    open("O que fazer");
    await clickVerify();
    await flush(3_000);
    await clickVerify();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toBe(JSON.stringify({ followUp: false }));
    await flush(3_500); // 6,5 s desde o 1º clique: a conferência do 1º clique foi cancelada
    expect(calls).toHaveLength(2);
    await flush(2_600);
    expect(calls).toHaveLength(3);
  });

  it("sem o domínio do painel o resultado manda configurá-lo", async () => {
    mockVerify([verifyResult({ state: "unavailable", progress: { a: null, txt: null, policy: null } })]);
    renderRow(sts("absent"));
    open("O que fazer");
    await clickVerify();
    expect(within(row()).getByTestId("mta-sts-result")).toHaveTextContent(/Configurações → Domínio do painel/);
  });

  it("erro do servidor (429 do limite de taxa) aparece na caixa e não derruba a tela", async () => {
    mockVerify([Response.json({ error: "mta_sts_verify_too_soon", message: "Espere 3 s." }, { status: 429 })]);
    renderRow(sts("absent"));
    open("O que fazer");
    await clickVerify();
    expect(within(row()).getByTestId("mta-sts-result")).toHaveTextContent("Espere 3 s.");
    // o botão volta a ficar disponível
    expect(within(row()).getByRole("button", { name: "Verificar" })).toBeEnabled();
  });

  it("enquanto verifica o botão fica desabilitado e diz 'Verificando…'", async () => {
    let release!: (r: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => (release = resolve))),
    );
    renderRow(sts("absent"));
    open("O que fazer");
    fireEvent.click(within(row()).getByRole("button", { name: /^Verificar/ }));
    await flush();
    const busy = within(row()).getByRole("button", { name: /Verificando/ });
    expect(busy).toBeDisabled();
    release(Response.json(verifyResult()));
    await flush();
    expect(within(row()).getByRole("button", { name: "Verificar" })).toBeEnabled();
  });

  it("no estado ativo o botão também existe (dentro dos Detalhes) e confirma", async () => {
    mockVerify([verifyResult({ state: "active", progress: { a: true, txt: true, policy: true } })]);
    renderRow(sts("testing", "ok"));
    open("Detalhes");
    await clickVerify();
    expect(within(row()).getByTestId("mta-sts-result")).toHaveTextContent("MTA-STS ativo em modo de teste. Nada mais a fazer.");
  });

  it("política que abre mas com o TXT desatualizado: o item vem do servidor, não vira 'Ativo' e o passo do TXT aparece", async () => {
    const outdated = sts("id_outdated");
    mockVerify([
      verifyResult({
        state: "attention",
        progress: { a: true, txt: false, policy: true },
        check: outdated,
        health: healthWith(outdated),
        missing: [{ id: "mta_sts", type: "TXT", name: `_mta-sts.${DOMAIN}`, value: "v=STSv1; id=novo999", outdated: true }],
      }),
    ]);
    renderLive(sts("absent"));
    open("O que fazer");
    await clickVerify();
    expect(screen.getByTestId("badge-mta_sts")).toHaveTextContent("Opcional · incompleto");
    expect(row().querySelector('[data-step="txt"]')).toHaveTextContent("v=STSv1; id=novo999");
    expect(row().querySelector("[data-mta-sts-active='true']")).toBeNull();
  });

  it("falta só o TXT (a política abre, DNS curinga): o resultado diz isso e nunca mostra 'Ativo'", async () => {
    const missing = sts("missing_txt");
    mockVerify([
      verifyResult({
        state: "missing_txt",
        progress: { a: true, txt: false, policy: false },
        check: missing,
        health: healthWith(missing),
        missing: [{ id: "mta_sts", type: "TXT", name: `_mta-sts.${DOMAIN}`, value: TXT }],
      }),
    ]);
    renderLive(sts("absent"));
    open("O que fazer");
    await clickVerify();
    const outcome = within(row()).getByTestId("mta-sts-result");
    expect(outcome).toHaveTextContent(/Registro TXT/);
    expect(outcome).not.toHaveTextContent(/ativo/i);
    expect(screen.getByTestId("badge-mta_sts")).not.toHaveTextContent("Ativo");
  });

  it("falta o TXT sem registro listado (consulta variou): mensagem própria", async () => {
    mockVerify([verifyResult({ state: "missing_txt", progress: { a: true, txt: false, policy: false } })]);
    renderRow(sts("missing_txt"));
    open("O que fazer");
    await clickVerify();
    expect(within(row()).getByTestId("mta-sts-result")).toHaveTextContent(/falta o TXT _mta-sts/);
  });

  it("política com algo a corrigir sem passos de DNS: a caixa manda ler a mensagem do item e o resultado não diz 'ativo'", async () => {
    const bad = sts("mx_mismatch", "critical", { inbox: true });
    mockVerify([verifyResult({ state: "attention", progress: { a: true, txt: true, policy: true }, check: bad, health: healthWith(bad) })]);
    renderLive(sts("absent"));
    open("O que fazer");
    await clickVerify();
    expect(within(row()).getByTestId("mta-sts-attention")).toBeInTheDocument();
    expect(within(row()).getByTestId("mta-sts-result")).toHaveTextContent(/aponta algo a corrigir/);
    expect(screen.getByTestId("badge-mta_sts")).toHaveTextContent("Crítico");
  });

  it("não deu para conferir (consulta do TXT ou do MX falhou): 'não conferido', nunca 'ativo'", async () => {
    mockVerify([verifyResult({ state: "unverified", progress: { a: null, txt: null, policy: null } })]);
    renderRow(sts("absent"));
    open("O que fazer");
    await clickVerify();
    const outcome = within(row()).getByTestId("mta-sts-result");
    expect(outcome).toHaveTextContent(/Não deu para conferir tudo agora/);
    expect(outcome).not.toHaveTextContent(/ativo/i);
  });

  it("teto de tentativas de emissão do botão: diz o horário em que volta e NÃO diz 'emitindo' nem agenda nova conferência", async () => {
    const until = new Date("2026-10-26T13:07:00Z");
    const calls = mockVerify([verifyResult({ state: "issuing", retryAfter: null, warmLimitUntil: until.toISOString(), progress: { a: true, txt: true, policy: false } })]);
    renderRow(sts("cert_pending"));
    open("O que fazer");
    await clickVerify();
    const outcome = within(row()).getByTestId("mta-sts-result");
    const hhmm = until.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    expect(outcome).toHaveTextContent(`Limite de tentativas de emissão por hora atingido; tente às ${hhmm}.`);
    expect(outcome).not.toHaveTextContent(/Emitindo o certificado/);
    expect(outcome).not.toHaveTextContent(/ainda está sendo emitido/);
    await flush(60_000);
    expect(calls).toHaveLength(1);
  });

  it("enforce ativo: o resultado diz o modo certo", async () => {
    const enforce = sts("enforce", "ok");
    mockVerify([verifyResult({ state: "active", progress: { a: true, txt: true, policy: true }, check: enforce, health: healthWith(enforce) })]);
    renderLive(sts("absent"));
    open("O que fazer");
    await clickVerify();
    expect(within(row()).getByTestId("mta-sts-result")).toHaveTextContent("MTA-STS ativo em modo enforce.");
  });

  it("sair da tela cancela o acompanhamento agendado", async () => {
    const calls = mockVerify([verifyResult({ state: "issuing", retryAfter: 6, progress: { a: true, txt: true, policy: false } })]);
    const view = renderRow(sts("cert_pending"));
    open("O que fazer");
    await clickVerify();
    view.unmount();
    await flush(30_000);
    expect(calls).toHaveLength(1);
  });

  it("MtaStsHowTo isolado, sem onResult: funciona e abre/fecha com aria-expanded", async () => {
    mockVerify([verifyResult()]);
    render(<MtaStsHowTo check={sts("absent")} plan={PLAN} />);
    const toggle = screen.getByRole("button", { name: "O que fazer" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: /^Verificar/ }));
    await flush();
    expect(screen.getByTestId("mta-sts-result")).toHaveTextContent(/Não deu para conferir o DNS agora/);
    fireEvent.click(toggle);
    expect(screen.queryByRole("region")).toBeNull();
  });
});

describe("dentro do cartão da saúde do e-mail", () => {
  function mockCard(state: DeliveryHealthStateResponse, verify?: MtaStsVerifyResponse) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => (String(input).endsWith("/mta-sts/verify") ? Response.json(verify ?? verifyResult()) : Response.json(state))),
    );
  }
  it("MTA-STS ativo não entra no resumo dos opcionais nem aparece como 'Bônus'", async () => {
    mockCard({ plan: PLAN, report: report([sts("testing", "ok")]) });
    render(<DeliveryHealthCard domain={DOMAIN} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.getByTestId("badge-mta_sts")).toHaveTextContent("Ativo");
    expect(screen.queryByTestId("optional-summary")).toBeNull();
    expect(screen.queryByText("Bônus")).toBeNull();
    expect(mailHealthScope("mta_sts")).toBe("domain");
  });

  it("enforce com MX errado continua CRÍTICO depois do Verificar: o aviso vermelho do topo e a contagem seguem o servidor", async () => {
    const bad = sts("mx_mismatch", "critical", { inbox: true });
    const badReport = {
      level: "critical" as const,
      counts: { ok: 0, warn: 0, critical: 1, optional: 0, acknowledged: 0 },
      inboxIssues: ["mta_sts" as const],
    };
    mockCard(
      { plan: PLAN, report: report([sts("absent")]) },
      verifyResult({ state: "attention", progress: { a: true, txt: true, policy: true }, check: bad, health: healthWith(bad, badReport) }),
    );
    render(<DeliveryHealthCard domain={DOMAIN} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(document.querySelector('[data-severity="critical"]')).toBeNull();
    open("O que fazer");
    await clickVerify();
    expect(screen.getByTestId("badge-mta_sts")).toHaveTextContent("Crítico");
    expect(screen.getByTestId("badge-mta_sts")).not.toHaveTextContent("Ativo");
    expect(row()).toHaveAttribute("data-level", "critical");
    expect(document.querySelector('[data-severity="critical"]')).not.toBeNull();
    expect(screen.getByTestId("delivery-health")).toHaveAttribute("data-level", "critical");
  });

  it("verificar com a política aberta troca o selo da linha para 'Ativo' e tira o item dos opcionais", async () => {
    mockCard(
      { plan: PLAN, report: report([sts("absent")]) },
      verifyResult({ state: "active", progress: { a: true, txt: true, policy: true }, check: sts("testing", "ok"), health: healthWith(sts("testing", "ok")) }),
    );
    render(<DeliveryHealthCard domain={DOMAIN} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.getByTestId("badge-mta_sts")).toHaveTextContent("Opcional · não configurado");
    open("O que fazer");
    await clickVerify();
    expect(screen.getByTestId("badge-mta_sts")).toHaveTextContent("Ativo");
    expect(row()).toHaveAttribute("data-level", "ok");
  });
});
