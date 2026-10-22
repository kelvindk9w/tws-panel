/**
 * Card "Saúde do envio de e-mail" (DeliveryHealthCard): estado por verificação,
 * aviso quando algo afeta a caixa de entrada, "Verificar agora", passo a passo
 * do DNS (Cloudflare em nuvem cinza, PTR no provedor) e o cuidado de nunca
 * prometer caixa de entrada. A API é simulada (fetch).
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeliveryHealthResponse, DeliveryHealthStateResponse, DnsPlanResponse } from "@paas/core";
import { DeliveryHealthCard } from "../src/components/mail/DeliveryHealthCard";
import { catalog } from "../src/i18n/core";

const DOMAIN = "envio.exemplo.com.br";

const PLAN: DnsPlanResponse = {
  domain: DOMAIN,
  serverHostname: `mail.${DOMAIN}`,
  ptr: { ip: "203.0.113.10", expected: `mail.${DOMAIN}` },
  mtaStsPolicy: "version: STSv1\r\nmode: testing\r\n",
  records: [
    { id: "a", order: 1, type: "A", name: `mail.${DOMAIN}`, value: "203.0.113.10", need: "required", purpose: "a", proxied: false },
    { id: "mx", order: 2, type: "MX", name: DOMAIN, value: `mail.${DOMAIN}`, priority: 10, need: "required", purpose: "mx", proxied: false },
    { id: "tls_rpt", order: 3, type: "TXT", name: `_smtp._tls.${DOMAIN}`, value: "v=TLSRPTv1; rua=mailto:postmaster@x", need: "optional", purpose: "tls_rpt", proxied: false },
  ],
};

function report(over: Partial<DeliveryHealthResponse> = {}): DeliveryHealthResponse {
  return {
    domain: DOMAIN,
    checkedAt: "2026-10-22T12:00:00.000Z",
    level: "critical",
    counts: { ok: 1, warn: 1, critical: 2 },
    inboxIssues: ["spf", "port25"],
    checks: [
      { id: "a", level: "ok", inbox: true, code: "ok", params: { host: `mail.${DOMAIN}`, ip: "203.0.113.10" } },
      {
        id: "spf",
        level: "critical",
        inbox: true,
        code: "missing",
        params: { domain: DOMAIN },
        expected: "v=spf1 ip4:203.0.113.10 ~all",
        found: [],
      },
      { id: "port25", level: "critical", inbox: true, code: "blocked", params: { detail: "ETIMEDOUT" } },
      { id: "ptr", level: "warn", inbox: true, code: "generic", params: { ip: "203.0.113.10", expected: `mail.${DOMAIN}`, current: "vmi1.contaboserver.net" } },
      { id: "mta_sts", level: "info", inbox: false, code: "absent", params: {} },
      { id: "helo", level: "ok", inbox: true, code: "ok", params: { host: "mail.outro.example.com", ip: "203.0.113.10" } },
    ],
    ...over,
  };
}

interface Call {
  method: string;
  url: string;
}

function mockApi(state: DeliveryHealthStateResponse | Response, afterCheck?: DeliveryHealthStateResponse): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url: String(input) });
      if (state instanceof Response) return state.clone();
      return Response.json(method === "POST" && afterCheck ? afterCheck : state);
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DeliveryHealthCard", () => {
  it("sem verificação ainda: pede para verificar e já mostra o passo a passo do DNS", async () => {
    mockApi({ plan: PLAN, report: null });
    render(<DeliveryHealthCard domain={DOMAIN} />);
    expect(await screen.findByText(/Ainda não verificado/)).toBeInTheDocument();
    expect(screen.getByText("Passo a passo do DNS")).toBeInTheDocument();
  });

  it("mostra cada verificação com estado e mensagem em português, e o aviso do que afeta a caixa de entrada", async () => {
    mockApi({ plan: PLAN, report: report() });
    render(<DeliveryHealthCard domain={DOMAIN} />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Há itens que afetam diretamente a caixa de entrada");
    expect(alert).toHaveTextContent("SPF, Porta 25 de saída");
    const spf = document.querySelector('[data-check="spf"]') as HTMLElement;
    expect(spf).toHaveAttribute("data-level", "critical");
    expect(within(spf).getByText("Crítico")).toBeInTheDocument();
    expect(within(spf).getByText(/não tem registro SPF/)).toBeInTheDocument();
    // esperado × encontrado
    expect(within(spf).getByText("v=spf1 ip4:203.0.113.10 ~all")).toBeInTheDocument();
    expect(within(spf).getByText("(nada)")).toBeInTheDocument();
    expect(screen.getByText(/porta 25/i, { selector: "p.text-muted-foreground" })).toBeInTheDocument();
    // atenção e bônus
    expect(within(document.querySelector('[data-check="ptr"]') as HTMLElement).getByText("Atenção")).toBeInTheDocument();
    expect(within(document.querySelector('[data-check="mta_sts"]') as HTMLElement).getByText("Bônus")).toBeInTheDocument();
    // o HELO usa as mensagens do registro A
    expect(within(document.querySelector('[data-check="helo"]') as HTMLElement).getByText(/aponta para 203\.0\.113\.10/)).toBeInTheDocument();
    expect(screen.getByText(/2 críticos/)).toBeInTheDocument();
    expect(screen.getByText(/Acabou de mexer no DNS/)).toBeInTheDocument();
  });

  it("tudo em ordem: sem alerta vermelho, sem promessa de caixa de entrada", async () => {
    mockApi({ plan: PLAN, report: report({ level: "ok", counts: { ok: 3, warn: 0, critical: 0 }, inboxIssues: [], checks: report().checks.slice(0, 1) }) });
    render(<DeliveryHealthCard domain={DOMAIN} />);
    expect(await screen.findByText(/Nenhum item que afete diretamente a caixa de entrada/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/Acabou de mexer no DNS/)).toBeNull();
    expect(screen.getByTestId("delivery-health")).toHaveAttribute("data-level", "ok");
  });

  // Frases que prometem o que nenhum servidor pode prometer. A negação ("não existe garantia") é tirada antes.
  const PROMESSAS: RegExp[] = [
    /garant(e|em|ido|ida|idos|idas|imos|iu|ir|irá|iria)\b/,
    /garantia de (entrega|caixa|inbox)/,
    /(vai|vão|irá|irão|deve|devem) (cair|chegar|entrar|ir|parar|ficar) (na|à|em|para a) (sua )?(caixa de entrada|inbox)/,
    /(cairá|chegará|entrará|ficará) (na|à|em) (sua )?(caixa de entrada|inbox)/,
    /(cai|chega|entra|fica) (sempre )?(na|à) (sua )?(caixa de entrada|inbox)/,
    /(nunca|jamais|não) (vai|irá|vão|cai|cairá) (cair |ir |parar )?(no|para o|na pasta de) ?(spam|lixo)/,
    /(evita|evitará|livra|elimina) (o )?(spam|lixo eletrônico)/,
    /(sem|zero) risco de (spam|rejeição)/,
    /sempre (chega|chegam|entrega|entregam|cai|caem)/,
    /100 ?%/,
    /guarantee[sd]?\b/,
    /(will|would|should) (land|arrive|reach|go|end up|be delivered) (in|to|into) (your |the )?(inbox|primary)/,
    /(lands?|arrives?|reaches|ends up) (in|to|into) (your |the )?inbox/,
    /(never|won't|will not|no longer) (land|go|end up|be sent) (in|to|into)? ?(the )?(spam|junk)/,
    /(avoids?|prevents?|eliminates?) (the )?(spam|junk)/,
    /(no|zero) risk of (spam|rejection)/,
    /always (reach|reaches|arrive|arrives|land|lands|deliver|delivers)/,
    /(inbox|delivery|placement)( placement)? (is |are )?(assured|ensured|guaranteed|certain)/,
    /(ensures?|assures?) (inbox|delivery)/,
  ];
  const NEGACOES =
    /(não existe|nenhuma|sem|não há|nem) garantia|no guarantee|not a guarantee|não é (uma )?garantia|no one can guarantee|cannot guarantee|can't guarantee|does not guarantee|doesn't guarantee|not guaranteed|não garante|não pode garantir|ninguém garante|nenhum servidor (garante|pode garantir)/g;
  const prometeAlgo = (text: string) => {
    const limpo = text.toLowerCase().replace(NEGACOES, " ");
    return PROMESSAS.filter((re) => re.test(limpo));
  };

  it("o detector de promessas pega frases típicas (teste negativo)", () => {
    for (const frase of [
      "Seu e-mail vai cair na caixa de entrada.",
      "A mensagem chegará à caixa de entrada do Gmail.",
      "Entrega garantida em todos os provedores.",
      "Evita o spam por completo",
      "Nunca vai cair no spam",
      "Your message lands in the inbox",
      "It will land in your inbox",
      "This setup guarantees delivery",
      "Inbox placement is assured",
      "Avoids spam entirely",
      "100% de entrega",
    ]) {
      expect(prometeAlgo(frase), frase).not.toEqual([]);
    }
    for (const frase of [
      "Não existe garantia de caixa de entrada.",
      "There is no guarantee of inbox placement.",
      "Aumenta as chances de a mensagem chegar, sem garantia.",
      "Nenhum item que afete diretamente a caixa de entrada.",
    ]) {
      expect(prometeAlgo(frase), frase).toEqual([]);
    }
  });

  it("nunca promete caixa de entrada: varre todo texto de e-mail em pt-BR e en", () => {
    const namespaces = ["mailHealth", "mail", "envios"];
    for (const locale of Object.keys(catalog)) {
      for (const ns of namespaces) {
        const dict = (catalog[locale] as unknown as Record<string, Record<string, string> | undefined>)[ns] ?? {};
        for (const [key, text] of Object.entries(dict)) {
          expect(prometeAlgo(String(text)), `${locale}.${ns}.${key}: ${String(text).slice(0, 80)}`).toEqual([]);
        }
      }
    }
    expect(catalog["pt-BR"]!.mailHealth!.description).toMatch(/não existe garantia/);
    expect(catalog.en!.mailHealth!.description).toMatch(/no guarantee/);
  });

  it("Verificar agora: faz o POST, mostra o resultado novo e desabilita enquanto verifica", async () => {
    const calls = mockApi({ plan: PLAN, report: null }, { plan: PLAN, report: report({ level: "ok", inboxIssues: [], counts: { ok: 1, warn: 0, critical: 0 }, checks: report().checks.slice(0, 1) }) });
    const user = userEvent.setup();
    render(<DeliveryHealthCard domain={DOMAIN} />);
    await screen.findByText(/Ainda não verificado/);
    await user.click(screen.getByRole("button", { name: "Verificar a saúde agora" }));
    expect(await screen.findByText(/Nenhum item que afete diretamente/)).toBeInTheDocument();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET /api/mail/domains/${DOMAIN}/health`, `POST /api/mail/domains/${DOMAIN}/health/check`]);
  });

  it("limite de uso (429) aparece como erro, sem perder o que já estava na tela", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(init?.method ?? "GET");
        if (init?.method === "POST") {
          return Response.json({ error: "health_check_too_soon", message: "Espere 10 s para verificar de novo." }, { status: 429 });
        }
        return Response.json({ plan: PLAN, report: report() });
      }),
    );
    const user = userEvent.setup();
    render(<DeliveryHealthCard domain={DOMAIN} />);
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Verificar a saúde agora" }));
    expect(await screen.findByText("Espere 10 s para verificar de novo.")).toBeInTheDocument();
    expect(document.querySelector('[data-check="spf"]')).not.toBeNull();
  });

  it("falha ao carregar: mostra o erro", async () => {
    mockApi(Response.json({ error: "x", message: "Servidor fora do ar." }, { status: 500 }));
    render(<DeliveryHealthCard domain={DOMAIN} />);
    expect(await screen.findByText("Servidor fora do ar.")).toBeInTheDocument();
  });

  it("passo a passo: registros em ordem, valor copiável, Cloudflare em nuvem cinza e PTR no provedor", async () => {
    mockApi({ plan: PLAN, report: null });
    const user = userEvent.setup();
    render(<DeliveryHealthCard domain={DOMAIN} />);
    await user.click(await screen.findByText("Passo a passo do DNS"));
    const rows = Array.from(document.querySelectorAll("[data-record]")).map((r) => r.getAttribute("data-record"));
    expect(rows).toEqual(["a", "mx", "tls_rpt"]);
    const mx = document.querySelector('[data-record="mx"]') as HTMLElement;
    expect(within(mx).getByText("Obrigatório")).toBeInTheDocument();
    expect(within(mx).getByText("10")).toBeInTheDocument();
    expect(within(mx).getByRole("button", { name: "Copiar valor de mx" })).toBeInTheDocument();
    expect(within(document.querySelector('[data-record="tls_rpt"]') as HTMLElement).getByText("Opcional (bônus)")).toBeInTheDocument();
    expect(screen.getByText(/nuvem CINZA/)).toBeInTheDocument();
    expect(screen.getByText(/O PTR do IP 203\.0\.113\.10 deve ser mail\.envio\.exemplo\.com\.br/)).toBeInTheDocument();
    expect(screen.getByText(/painel do provedor da VPS/, { selector: "p.text-muted-foreground" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copiar política" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Guia completo/ })).toHaveAttribute("href", expect.stringContaining("/guides/email-deliverability/"));
  });
});

describe("mensagens do servidor x dicionário", () => {
  // Cada código que o servidor pode devolver precisa ter texto nos dois idiomas
  // (packages/mailer/src/deliverability-health.ts).
  const CODES: Record<string, string[]> = {
    a: ["ok", "missing", "mismatch", "proxied", "unavailable"],
    mx: ["ok", "missing", "other", "target_wrong_ip", "unavailable"],
    spf: ["ok_hard", "ok_soft", "missing", "multiple", "too_many_lookups", "ip_missing", "weak_all", "near_limit", "uses_ptr", "permerror", "has_macros", "unavailable"],
    dkim: ["ok", "missing", "revoked", "invalid_key", "mismatch", "weak_key", "short_key", "restart_pending", "unavailable"],
    dmarc: ["none", "quarantine", "reject", "missing", "multiple", "invalid", "inherited", "no_rua", "unavailable"],
    ptr: ["ok", "generic", "mismatch", "missing", "unavailable"],
    port25: ["ok", "blocked", "unavailable"],
    queue: ["empty", "unavailable", "deferred_greylisted", "deferred_auth", "deferred_rate_limited", "deferred_blocked_ip", "deferred_mailbox", "deferred_tls", "deferred_dns", "deferred_connection", "deferred_other"],
    tls: ["ok", "expiring", "expiring_soon", "invalid", "server_stopped", "no_hosts", "expiry_unknown"],
    dnsbl: ["ok", "listed", "unknown", "not_checked"],
    propagation: ["ok", "partial", "none"],
    mta_sts: ["absent", "unreachable", "invalid", "mx_mismatch", "testing", "enforce"],
    tls_rpt: ["ok", "absent", "no_rua"],
  };
  const CHECKS = ["a", "helo", "mx", "spf", "dkim", "dmarc", "ptr", "port25", "queue", "tls", "dnsbl", "propagation", "mta_sts", "tls_rpt"];

  it.each(Object.keys(catalog))("%s tem todas as mensagens", (locale) => {
    const dict = catalog[locale]!.mailHealth!;
    const missing = Object.entries(CODES).flatMap(([id, codes]) => codes.filter((c) => !(`msg.${id}.${c}` in dict)).map((c) => `${id}.${c}`));
    expect(missing).toEqual([]);
    expect(CHECKS.filter((id) => !(`check.${id}` in dict))).toEqual([]);
    for (const id of ["a", "a_helo", "aaaa", "mx", "spf", "dkim", "dmarc", "tls_rpt", "mta_sts"]) expect(`plan.${id}.purpose` in dict).toBe(true);
  });
});
