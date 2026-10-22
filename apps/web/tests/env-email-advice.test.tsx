/**
 * Seção Variáveis — aviso "o e-mail do projeto preenche estas variáveis".
 *
 * Caso real (validação do dono): o compose exige SMTP_HOST, SMTP_PORT,
 * SMTP_SECURE, SMTP_USER, SMTP_PASSWORD e SMTP_FROM; a aba Variáveis não dizia
 * que o E-mail do projeto entrega a maioria delas. O aviso liga o e-mail, sugere
 * ligar os nomes diferentes (SMTP_PASSWORD ← SMTP_PASS) e atalha o que é manual
 * (SMTP_SECURE=false) — sem salvar nada sozinho.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@paas/core";
import { MemoryRouter } from "react-router";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { ProjectEnvCard } from "@/components/ProjectEnvCard";
import { ApiRequestError } from "@/lib/api";
import { setLocale } from "@/i18n/core";

const PROJECT = { id: "p1", name: "loja", slug: "loja", detection: { type: "compose" } } as unknown as Project;

const SMTP_COMPOSE = ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASSWORD", "SMTP_FROM"].map(
  (name) => ({ name, required: true, defaultValue: null }),
);

const EMAIL_ENV = {
  SMTP_HOST: "mail.example.com",
  SMTP_PORT: "587",
  SMTP_USER: "loja@example.com",
  SMTP_PASS: "••••",
  MAIL_FROM: "loja@example.com",
};

function emailOn(links: Record<string, string> = {}) {
  return { enabled: true, domain: "example.com", mailbox: "loja@example.com", mailFrom: "loja@example.com", env: EMAIL_ENV, envLinks: links };
}
const EMAIL_OFF = { enabled: false, domain: null, mailbox: null, mailFrom: null, env: {} };

interface World {
  vars?: { key: string; value: string }[];
  compose?: { name: string; required: boolean; defaultValue: string | null }[] | null;
  email?: unknown;
  emailFails?: boolean;
  linksFail?: ApiRequestError;
  /** O que GET /env devolve (filtrado: só o que o e-mail entrega agora). */
  provided?: string[];
  linksShown?: Record<string, string>;
}

function serve(w: World) {
  const links = (w.email as { envLinks?: Record<string, string> } | undefined)?.envLinks ?? {};
  const provided = w.provided ?? (w.email && (w.email as { enabled: boolean }).enabled
    ? [...Object.keys(EMAIL_ENV), ...Object.keys(links)].filter((n) => n !== "SMTP_PASS" || true)
    : []);
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.endsWith("/email/links")) {
      if (w.linksFail) throw w.linksFail;
      const sent = JSON.parse(String(init?.body)).links as Record<string, string>;
      return { email: emailOn(sent) };
    }
    if (path.endsWith("/email")) {
      if (w.emailFails) throw new Error("boom");
      return { email: w.email ?? EMAIL_OFF };
    }
    if (init?.method === "PUT") return JSON.parse(String(init.body));
    return {
      vars: w.vars ?? [],
      compose: w.compose === null ? null : { variables: w.compose ?? SMTP_COMPOSE },
      provided,
      providedValues: Object.fromEntries(Object.entries(EMAIL_ENV).filter(([k]) => k !== "SMTP_PASS")),
      links: w.linksShown ?? links,
    };
  });
}

function renderCard() {
  return render(
    <MemoryRouter>
      <ProjectEnvCard project={PROJECT} />
    </MemoryRouter>,
  );
}

const puts = (path: string) =>
  apiFetchMock.mock.calls.filter(([p, i]) => String(p).endsWith(path) && (i as RequestInit | undefined)?.method === "PUT");

beforeEach(() => {
  apiFetchMock.mockReset();
  window.localStorage.clear();
  setLocale("pt-BR", { persist: false });
});
afterEach(cleanup);

describe("aviso do e-mail do projeto nas Variáveis", () => {
  it("e-mail desligado: diz o que ele preenche e leva ao cartão E-mail do projeto", async () => {
    serve({ email: EMAIL_OFF });
    renderCard();
    const aviso = await screen.findByTestId("env-email-advice");
    expect(aviso).toHaveAttribute("role", "status");
    expect(aviso).toHaveTextContent("SMTP_HOST");
    expect(aviso).toHaveTextContent(/não precisa digitar/i);
    const link = within(aviso).getByRole("link", { name: /Ligar o e-mail do projeto/ });
    expect(link).toHaveAttribute("href", "/projects/p1/email");
    expect(within(aviso).getByTestId("env-email-item-SMTP_HOST")).toHaveTextContent(/falta/i);
  });

  it("e-mail ligado com nomes diferentes: sugere ligar SMTP_PASSWORD e SMTP_FROM, mostrando o que será ligado", async () => {
    serve({ email: emailOn() });
    renderCard();
    const aviso = await screen.findByTestId("env-email-advice");
    expect(within(aviso).getByTestId("env-email-item-SMTP_HOST")).toHaveTextContent(/fornecida pelo e-mail do projeto/i);
    expect(within(aviso).getByTestId("env-email-item-SMTP_PASSWORD")).toHaveTextContent(/SMTP_PASS/);
    expect(aviso).toHaveTextContent(/nada é copiado/i);
    expect(within(aviso).getByRole("button", { name: "Ligar SMTP_PASSWORD ao valor SMTP_PASS" })).toBeInTheDocument();
    expect(within(aviso).getByRole("button", { name: "Ligar SMTP_FROM ao valor MAIL_FROM" })).toBeInTheDocument();
    expect(within(aviso).getByRole("button", { name: /Ligar todas as sugeridas \(2\)/ })).toBeInTheDocument();
  });

  it("um clique liga só aquela sugestão, preservando as ligações que já existem, e sem copiar valores", async () => {
    serve({ email: emailOn({ EMAIL_DE: "MAIL_FROM" }), compose: [...SMTP_COMPOSE] });
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Ligar SMTP_PASSWORD ao valor SMTP_PASS" }));
    await waitFor(() => expect(puts("/email/links")).toHaveLength(1));
    expect(JSON.parse(String((puts("/email/links")[0]![1] as RequestInit).body))).toEqual({
      links: { EMAIL_DE: "MAIL_FROM", SMTP_PASSWORD: "SMTP_PASS" },
    });
    // as Variáveis não foram tocadas
    expect(puts("/env")).toHaveLength(0);
    await waitFor(() =>
      expect(screen.getByTestId("env-email-item-SMTP_PASSWORD")).toHaveTextContent(/ligada a SMTP_PASS/),
    );
    expect(screen.queryByRole("button", { name: "Ligar SMTP_PASSWORD ao valor SMTP_PASS" })).not.toBeInTheDocument();
  });

  it("Ligar todas as sugeridas manda tudo numa só chamada; clique duplo não repete", async () => {
    serve({ email: emailOn() });
    renderCard();
    const all = await screen.findByRole("button", { name: /Ligar todas as sugeridas/ });
    fireEvent.click(all);
    fireEvent.click(all);
    await waitFor(() => expect(puts("/email/links")).toHaveLength(1));
    expect(JSON.parse(String((puts("/email/links")[0]![1] as RequestInit).body)).links).toEqual({
      SMTP_PASSWORD: "SMTP_PASS",
      SMTP_FROM: "MAIL_FROM",
    });
  });

  it("falha da rota: mensagem com o nome da variável, no alerta, e o botão volta", async () => {
    serve({ email: emailOn(), linksFail: new ApiRequestError(400, "invalid_env_key", "Nome reservado.") });
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Ligar SMTP_PASSWORD ao valor SMTP_PASS" }));
    const alerta = await screen.findByRole("alert");
    expect(alerta).toHaveTextContent("SMTP_PASSWORD");
    expect(alerta).toHaveTextContent("Nome reservado.");
    expect(screen.getByRole("button", { name: "Ligar SMTP_PASSWORD ao valor SMTP_PASS" })).toBeEnabled();
  });

  it("SMTP_SECURE é manual: dica com 587/STARTTLS e atalho que só adiciona a linha, sem salvar", async () => {
    serve({ email: emailOn({ SMTP_PASSWORD: "SMTP_PASS", SMTP_FROM: "MAIL_FROM" }) });
    renderCard();
    const aviso = await screen.findByTestId("env-email-advice");
    const item = within(aviso).getByTestId("env-email-item-SMTP_SECURE");
    expect(item).toHaveTextContent(/à mão/i);
    expect(item).toHaveTextContent("587");
    expect(item).toHaveTextContent("STARTTLS");
    expect(within(aviso).queryByRole("button", { name: /Ligar SMTP_PASSWORD/ })).not.toBeInTheDocument();
    fireEvent.click(within(aviso).getByRole("button", { name: "Adicionar SMTP_SECURE=false" }));
    expect(puts("/env")).toHaveLength(0);
    // a linha está na tabela com o valor, e o aviso some (a variável foi resolvida)
    expect(await screen.findByDisplayValue("false")).toBeInTheDocument();
    expect(screen.queryByTestId("env-email-advice")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Salvar variáveis/ }));
    await waitFor(() => expect(puts("/env")).toHaveLength(1));
    expect(JSON.parse(String((puts("/env")[0]![1] as RequestInit).body)).vars).toContainEqual({
      key: "SMTP_SECURE",
      value: "false",
    });
  });

  it("só SMTP_SECURE falta e o e-mail está desligado: sem introdução quebrada nem botão de ligar o e-mail", async () => {
    serve({
      email: EMAIL_OFF,
      compose: [{ name: "SMTP_SECURE", required: true, defaultValue: null }],
    });
    renderCard();
    const aviso = await screen.findByTestId("env-email-advice");
    expect(aviso).not.toHaveTextContent(/O projeto exige \./);
    expect(within(aviso).queryByRole("link", { name: /Ligar o e-mail do projeto/ })).not.toBeInTheDocument();
    expect(within(aviso).getByRole("button", { name: "Adicionar SMTP_SECURE=false" })).toBeInTheDocument();
  });

  it("Adicionar SMTP_SECURE=false cria a linha quando a sugerida foi removida da tabela, sem salvar", async () => {
    serve({ email: EMAIL_OFF, compose: [{ name: "SMTP_SECURE", required: true, defaultValue: null }] });
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Remover SMTP_SECURE" }));
    expect(screen.queryByDisplayValue("SMTP_SECURE")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Adicionar SMTP_SECURE=false" }));
    expect(screen.getByDisplayValue("SMTP_SECURE")).toBeInTheDocument();
    expect(screen.getByDisplayValue("false")).toBeInTheDocument();
    expect(puts("/env")).toHaveLength(0);
  });

  it("senha desconhecida (caixa adotada): o e-mail não entrega os valores padrão, então não sugere ligar", async () => {
    serve({
      email: emailOn({ EMAIL_DE: "MAIL_FROM", APP_SMTP_PASS: "SMTP_PASS" }),
      provided: [],
      linksShown: {},
    });
    renderCard();
    const aviso = await screen.findByTestId("env-email-advice");
    expect(within(aviso).queryByRole("button", { name: /Ligar SMTP_PASSWORD/ })).not.toBeInTheDocument();
    expect(within(aviso).getByTestId("env-email-item-SMTP_PASSWORD")).toHaveTextContent(/não fornece este valor agora/);
  });

  it("ligar não apaga ligações guardadas que o GET filtrou (o PUT parte do mapa guardado)", async () => {
    serve({
      email: emailOn({ EMAIL_DE: "MAIL_FROM", APP_SMTP_PASS: "SMTP_PASS" }),
      linksShown: {}, // o GET /env esconde as ligações que o e-mail não entrega agora
    });
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Ligar SMTP_PASSWORD ao valor SMTP_PASS" }));
    await waitFor(() => expect(puts("/email/links")).toHaveLength(1));
    expect(JSON.parse(String((puts("/email/links")[0]![1] as RequestInit).body)).links).toEqual({
      EMAIL_DE: "MAIL_FROM",
      APP_SMTP_PASS: "SMTP_PASS",
      SMTP_PASSWORD: "SMTP_PASS",
    });
  });

  it("nome já ligado (guardado) mas sem valor agora não ganha sugestão", async () => {
    serve({
      email: emailOn({ SMTP_PASSWORD: "SMTP_PASS" }),
      linksShown: {},
    });
    renderCard();
    const aviso = await screen.findByTestId("env-email-advice");
    expect(within(aviso).queryByRole("button", { name: /Ligar SMTP_PASSWORD/ })).not.toBeInTheDocument();
  });

  it("MAIL_FROM_NAME e apelidos são entregues pelo deploy: sugerem ligar quando o painel os fornece", async () => {
    serve({
      email: emailOn(),
      compose: [{ name: "SMTP_FROM_NAME", required: true, defaultValue: null }],
      provided: [...Object.keys(EMAIL_ENV), "MAIL_FROM_NAME"],
    });
    renderCard();
    expect(await screen.findByRole("button", { name: "Ligar SMTP_FROM_NAME ao valor MAIL_FROM_NAME" })).toBeInTheDocument();
  });

  it("tudo resolvido: nenhum aviso", async () => {
    serve({
      email: emailOn({ SMTP_PASSWORD: "SMTP_PASS", SMTP_FROM: "MAIL_FROM" }),
      vars: [{ key: "SMTP_SECURE", value: "false" }],
    });
    renderCard();
    await screen.findByTestId("env-count");
    expect(screen.queryByTestId("env-email-advice")).not.toBeInTheDocument();
  });

  it("projeto sem variáveis de e-mail obrigatórias, ou sem compose: nenhum aviso", async () => {
    serve({ email: EMAIL_OFF, compose: [{ name: "DATABASE_URL", required: true, defaultValue: null }] });
    renderCard();
    await screen.findByTestId("env-count");
    expect(screen.queryByTestId("env-email-advice")).not.toBeInTheDocument();
    cleanup();
    serve({ email: EMAIL_OFF, compose: null });
    renderCard();
    await screen.findByTestId("env-count");
    expect(screen.queryByTestId("env-email-advice")).not.toBeInTheDocument();
  });

  it("colisão: valor digitado no nome padrão substitui o do e-mail; ligada ignora o valor salvo", async () => {
    serve({
      email: emailOn({ SMTP_PASSWORD: "SMTP_PASS", SMTP_FROM: "MAIL_FROM" }),
      vars: [
        { key: "SMTP_HOST", value: "smtp.outro.example.com" },
        { key: "SMTP_FROM", value: "antigo@example.com" },
        { key: "SMTP_SECURE", value: "false" },
      ],
    });
    renderCard();
    const aviso = await screen.findByTestId("env-email-advice");
    expect(within(aviso).getByTestId("env-email-collision-SMTP_HOST")).toHaveTextContent(/só vale na interpolação do compose/i);
    expect(within(aviso).getByTestId("env-email-collision-SMTP_FROM")).toHaveTextContent(/ignorado/i);
  });

  it("não consegue consultar o e-mail: avisa e aponta para a tela do e-mail, sem botões de ligar", async () => {
    serve({ emailFails: true });
    renderCard();
    const aviso = await screen.findByTestId("env-email-advice");
    expect(aviso).toHaveTextContent(/não consegui consultar/i);
    expect(within(aviso).getByRole("link", { name: /E-mail do projeto/ })).toHaveAttribute("href", "/projects/p1/email");
    expect(within(aviso).queryByRole("button", { name: /Ligar/ })).not.toBeInTheDocument();
  });

  it("não regride o Mostrar valores global e a contagem", async () => {
    serve({ email: EMAIL_OFF, vars: [{ key: "SMTP_SECURE", value: "false" }] });
    renderCard();
    await screen.findByTestId("env-email-advice");
    expect(screen.getByTestId("env-count")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Mostrar valores$/ }));
    expect(screen.getByRole("button", { name: /^Ocultar valores$/ })).toBeInTheDocument();
    expect(screen.getByDisplayValue("false")).toHaveAttribute("type", "text");
  });

  it("consulta falhou: diz que não deu para saber", async () => {
    serve({ emailFails: true });
    renderCard();
    expect(await screen.findByTestId("env-email-item-SMTP_HOST")).toHaveTextContent(/não deu para saber/);
  });

  it("em inglês: textos, botões e dica traduzidos", async () => {
    setLocale("en", { persist: false });
    serve({ email: emailOn() });
    renderCard();
    const aviso = await screen.findByTestId("env-email-advice");
    expect(within(aviso).getByRole("button", { name: "Link SMTP_PASSWORD to the SMTP_PASS value" })).toBeInTheDocument();
    expect(within(aviso).getByTestId("env-email-item-SMTP_SECURE")).toHaveTextContent(/by hand/i);
    expect(within(aviso).getByRole("button", { name: "Add SMTP_SECURE=false" })).toBeInTheDocument();
    cleanup();
    serve({ email: EMAIL_OFF });
    renderCard();
    const off = await screen.findByTestId("env-email-advice");
    expect(within(off).getByRole("link", { name: "Turn on project email" })).toHaveAttribute("href", "/projects/p1/email");
  });
});
