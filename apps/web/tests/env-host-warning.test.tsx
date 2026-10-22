/**
 * Seção Variáveis — aviso âmbar quando uma variável de HOST (SITE_HOST,
 * *_HOSTNAME, *_DOMAIN) tem esquema, barra, porta ou espaço.
 *
 * Caso real (validação do dono): SITE_HOST=http://… e CARTEIRA_HOST=https://…
 * salvos; o Caddy do projeto montou "http://http://…" e a tela ficou em branco
 * sem nenhuma pista. O aviso NÃO bloqueia o salvar; "Corrigir" tira o esquema
 * e a barra. Variáveis *_URL nunca são afetadas.
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

const PROJECT = { id: "p1", name: "loja", slug: "loja", detection: { type: "compose" } } as unknown as Project;

function serve(vars: { key: string; value: string }[]) {
  apiFetchMock.mockImplementation(async (_path: string, init?: RequestInit) =>
    init?.method === "PUT" ? JSON.parse(String(init.body)) : { vars },
  );
}

function renderCard() {
  return render(
    <MemoryRouter>
      <ProjectEnvCard project={PROJECT} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiFetchMock.mockReset();
  window.localStorage.clear();
});
afterEach(cleanup);

describe("aviso de variável de host", () => {
  it("SITE_HOST com esquema: avisa em português, sugere só o host e oferece Corrigir", async () => {
    serve([{ key: "SITE_HOST", value: "http://site.example.com" }]);
    renderCard();
    const aviso = await screen.findByTestId("env-host-warning-SITE_HOST");
    expect(aviso).toHaveTextContent(/esquema/);
    expect(aviso).toHaveTextContent("site.example.com");
    expect(aviso).toHaveTextContent(/não bloqueia/i);
    expect(within(aviso).getByRole("button", { name: /Corrigir SITE_HOST/ })).toBeInTheDocument();
  });

  it("Corrigir troca o valor pela sugestão e o aviso some", async () => {
    serve([{ key: "CARTEIRA_HOST", value: "https://carteira.example.com/" }]);
    renderCard();
    const aviso = await screen.findByTestId("env-host-warning-CARTEIRA_HOST");
    expect(aviso).toHaveTextContent(/esquema/);
    expect(aviso).toHaveTextContent(/barra/);
    fireEvent.click(within(aviso).getByRole("button", { name: /Corrigir/ }));
    expect(screen.queryByTestId("env-host-warning-CARTEIRA_HOST")).not.toBeInTheDocument();
    // o valor corrigido não é salvo sozinho: só vale ao salvar
    expect(apiFetchMock.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === "PUT")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /Salvar variáveis/ }));
    await waitFor(() => {
      const put = apiFetchMock.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === "PUT");
      expect(JSON.parse(String((put?.[1] as RequestInit).body))).toEqual({
        vars: [{ key: "CARTEIRA_HOST", value: "carteira.example.com" }],
      });
    });
  });

  it("não bloqueia o salvar: o valor estranho segue como está", async () => {
    serve([{ key: "SITE_HOST", value: "http://site.example.com" }]);
    renderCard();
    await screen.findByTestId("env-host-warning-SITE_HOST");
    fireEvent.click(screen.getByRole("button", { name: /Salvar variáveis/ }));
    await waitFor(() => {
      const put = apiFetchMock.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === "PUT");
      expect(JSON.parse(String((put?.[1] as RequestInit).body)).vars).toEqual([{ key: "SITE_HOST", value: "http://site.example.com" }]);
    });
  });

  it("porta e espaço também avisam; host certo, vazio e *_URL não", async () => {
    serve([
      { key: "MAIL_HOST", value: "mail.example.com:587" },
      { key: "APP_DOMAIN", value: " app.example.com" },
      { key: "OK_HOST", value: "ok.example.com" },
      { key: "VAZIO_HOST", value: "" },
      { key: "SITE_URL", value: "https://site.example.com/" },
    ]);
    renderCard();
    expect(await screen.findByTestId("env-host-warning-MAIL_HOST")).toHaveTextContent(/porta/);
    expect(screen.getByTestId("env-host-warning-APP_DOMAIN")).toHaveTextContent(/espaço/);
    for (const nome of ["OK_HOST", "VAZIO_HOST", "SITE_URL"]) {
      expect(screen.queryByTestId(`env-host-warning-${nome}`)).not.toBeInTheDocument();
    }
  });

  it("editar o valor reavalia o aviso na hora", async () => {
    serve([{ key: "SITE_HOST", value: "site.example.com" }]);
    renderCard();
    const campo = await screen.findByLabelText(/Valor da variável 1/);
    expect(screen.queryByTestId("env-host-warning-SITE_HOST")).not.toBeInTheDocument();
    fireEvent.change(campo, { target: { value: "https://site.example.com" } });
    expect(await screen.findByTestId("env-host-warning-SITE_HOST")).toBeInTheDocument();
  });

  it("nome com cara de segredo: o aviso existe, mas não mostra o valor sugerido", async () => {
    serve([{ key: "AUTH_HOST", value: "https://oculto.example.com" }]);
    renderCard();
    const aviso = await screen.findByTestId("env-host-warning-AUTH_HOST");
    expect(aviso).not.toHaveTextContent("oculto.example.com");
    expect(within(aviso).getByRole("button", { name: /Corrigir AUTH_HOST/ })).toBeInTheDocument();
  });

  it("valor com usuário:senha: o aviso não repete nem o host sugerido", async () => {
    serve([{ key: "SITE_HOST", value: "https://usuario:senha-secreta@site.example.com" }]);
    renderCard();
    const aviso = await screen.findByTestId("env-host-warning-SITE_HOST");
    expect(aviso).not.toHaveTextContent("senha-secreta");
    expect(aviso).not.toHaveTextContent("site.example.com");
  });
});

describe("importação de .env", () => {
  it("variáveis de host estranhas vêm com aviso e a importação diz quantas", async () => {
    serve([]);
    renderCard();
    await screen.findByText(/Nenhuma variável ainda/);
    const input = screen.getByTestId("env-file-input");
    fireEvent.change(input, {
      target: { files: [new File(["SITE_HOST=http://site.example.com\nCARTEIRA_HOST=https://carteira.example.com/\nOK_HOST=ok.example.com\n"], ".env")] },
    });
    expect(await screen.findByTestId("env-host-warning-SITE_HOST")).toBeInTheDocument();
    expect(screen.getByTestId("env-host-warning-CARTEIRA_HOST")).toBeInTheDocument();
    expect(screen.queryByTestId("env-host-warning-OK_HOST")).not.toBeInTheDocument();
    expect(screen.getByTestId("env-import-result")).toHaveTextContent(/2 variáveis de host/);
  });

  it("importação sem variável de host estranha não menciona host", async () => {
    serve([]);
    renderCard();
    await screen.findByText(/Nenhuma variável ainda/);
    fireEvent.change(screen.getByTestId("env-file-input"), { target: { files: [new File(["A=1\n"], ".env")] } });
    expect(await screen.findByTestId("env-import-result")).not.toHaveTextContent(/host/);
  });
});
