/**
 * Card "Enviar e-mail de teste" (página do domínio de e-mail): envio, consulta
 * periódica do destino e os resultados com cor — entregue (verde), recusado
 * (vermelho), adiado (amarelo). A API é simulada (fetch); o intervalo de
 * consulta é encurtado pelos props.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MailTestStatus } from "@paas/core";
import { TestEmailCard } from "../src/components/mail/TestEmailCard";

const DOMAIN = "envio.exemplo.com.br";

function status(overrides: Partial<MailTestStatus> = {}): MailTestStatus {
  return {
    id: "0123456789abcdef",
    domain: DOMAIN,
    from: `postmaster@${DOMAIN}`,
    to: "pessoa@gmail.com",
    sentAt: "2026-10-01T12:00:00.000Z",
    checkedAt: "2026-10-01T12:00:00.000Z",
    state: "queued",
    detail: null,
    nextRetryAt: null,
    confirmed: false,
    final: false,
    ...overrides,
  };
}

interface Call {
  method: string;
  url: string;
  body: unknown;
}

/** POST devolve `sent`; cada GET devolve o próximo da fila `polls` (o último se repete). */
function mockApi(sent: MailTestStatus | { status: number; body: unknown }, polls: MailTestStatus[] = []): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method === "POST") {
        if ("state" in sent) return Response.json({ test: sent }, { status: 202 });
        return Response.json(sent.body, { status: sent.status });
      }
      const next = polls.length > 1 ? polls.shift()! : polls[0]!;
      return Response.json({ test: next });
    }),
  );
  return calls;
}

async function send(user: ReturnType<typeof userEvent.setup>, to = "pessoa@gmail.com") {
  await user.type(screen.getByPlaceholderText(/gmail/i), to);
  await user.click(screen.getByRole("button", { name: /enviar/i }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TestEmailCard", () => {
  it("envia para o endereço digitado e acompanha até 'entregue' (verde), lembrando da pasta Spam", async () => {
    const calls = mockApi(status(), [
      status(),
      status({
        state: "delivered",
        final: true,
        confirmed: true,
        detail: "delivered to 'gmail-smtp-in.l.google.com' with code 250 (2.0.0) 'OK'",
      }),
    ]);
    const user = userEvent.setup();
    render(<TestEmailCard domain={DOMAIN} pollMs={5} maxPollMs={5_000} />);

    expect(screen.getByText(/postmaster@envio\.exemplo\.com\.br/)).toBeInTheDocument();
    await send(user);

    expect(calls[0]).toEqual({
      method: "POST",
      url: `/api/mail/domains/${DOMAIN}/test-email`,
      body: { to: "pessoa@gmail.com" },
    });
    const ok = await screen.findByText(/Entregue ao servidor do destinatário \(aceito pelo Gmail\)/);
    expect(ok.closest("[data-state]")).toHaveAttribute("data-state", "delivered");
    expect(screen.getByText(/gmail-smtp-in\.l\.google\.com/)).toBeInTheDocument();
    expect(screen.getByText(/pasta Spam/)).toBeInTheDocument();
    const gets = calls.filter((c) => c.method === "GET");
    expect(gets[0]!.url).toBe(`/api/mail/domains/${DOMAIN}/test-email/0123456789abcdef`);
    // terminou: para de consultar
    const count = calls.length;
    await new Promise((r) => setTimeout(r, 40));
    expect(calls.length).toBe(count);
  });

  it("enquanto está na fila, mostra 'Na fila / tentando entregar'", async () => {
    mockApi(status(), [status()]);
    const user = userEvent.setup();
    render(<TestEmailCard domain={DOMAIN} pollMs={5_000} maxPollMs={60_000} />);
    await send(user);
    const queued = await screen.findByText(/Na fila \/ tentando entregar/);
    expect(queued.closest("[data-state]")).toHaveAttribute("data-state", "queued");
  });

  it("recusado (vermelho) com o motivo devolvido pelo servidor do destinatário", async () => {
    mockApi(status(), [
      status({ state: "bounced", final: true, confirmed: true, detail: "550 5.7.1 Our system has detected an unusual rate" }),
    ]);
    const user = userEvent.setup();
    render(<TestEmailCard domain={DOMAIN} pollMs={5} maxPollMs={5_000} />);
    await send(user);
    const bounced = await screen.findByText(/Recusado: 550 5\.7\.1 Our system has detected an unusual rate/);
    expect(bounced.closest("[data-state]")).toHaveAttribute("data-state", "bounced");
  });

  it("adiado (amarelo) com o motivo e o horário da nova tentativa", async () => {
    const nextRetryAt = "2026-10-01T15:07:00.000Z";
    const hhmm = new Date(nextRetryAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    mockApi(status(), [
      status({ state: "deferred", detail: "Connection to 'gmail-smtp-in.l.google.com' failed: timed out", nextRetryAt }),
    ]);
    const user = userEvent.setup();
    render(<TestEmailCard domain={DOMAIN} pollMs={5} maxPollMs={5_000} />);
    await send(user);
    const deferred = await screen.findByText(new RegExp(`Adiada: Connection to .* failed: timed out, nova tentativa às ${hhmm}`));
    expect(deferred.closest("[data-state]")).toHaveAttribute("data-state", "deferred");
  });

  it("entregue sem recibo: diz que saiu da fila sem erro", async () => {
    const to = "alguem@outlook.com";
    mockApi(status({ to }), [
      status({ to, state: "delivered", final: true, confirmed: false, detail: "A mensagem saiu da fila sem erro registrado." }),
    ]);
    const user = userEvent.setup();
    render(<TestEmailCard domain={DOMAIN} pollMs={5} maxPollMs={5_000} />);
    await send(user, "alguem@outlook.com");
    expect(await screen.findByText(/aceito pela Microsoft \(Outlook\)/)).toBeInTheDocument();
    expect(screen.getByText(/saiu da fila sem erro/)).toBeInTheDocument();
  });

  it("depois do tempo máximo para de consultar e oferece 'Conferir de novo'", async () => {
    const calls = mockApi(status(), [status()]);
    const user = userEvent.setup();
    render(<TestEmailCard domain={DOMAIN} pollMs={5} maxPollMs={30} />);
    await send(user);
    const again = await screen.findByRole("button", { name: /conferir de novo/i });
    expect(screen.getByText(/continua tentando/)).toBeInTheDocument();
    const before = calls.length;
    await user.click(again);
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(before));
  });

  it("erro do servidor (ex.: limite de frequência) aparece na tela", async () => {
    mockApi({ status: 429, body: { error: "test_rate_limited", message: "Aguarde 20 s para enviar outro e-mail de teste." } });
    const user = userEvent.setup();
    render(<TestEmailCard domain={DOMAIN} pollMs={5} maxPollMs={5_000} />);
    await send(user);
    expect(await screen.findByText("Aguarde 20 s para enviar outro e-mail de teste.")).toBeInTheDocument();
  });

  it("botão desabilitado sem endereço", () => {
    mockApi(status());
    render(<TestEmailCard domain={DOMAIN} />);
    expect(screen.getByRole("button", { name: /enviar/i })).toBeDisabled();
  });
});
