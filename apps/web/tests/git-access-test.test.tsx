/**
 * Assistente Novo projeto — botão "Testar acesso" do repositório privado.
 *
 * Antes, o token era guardado e o erro só aparecia no clone, no passo seguinte.
 * Agora o botão consulta o repositório (somente leitura) e diz em português se
 * o painel consegue ler: ok (com as branches), token inválido, sem permissão,
 * repositório inexistente, branch inexistente, host inacessível, tempo esgotado.
 * O token digitado nunca aparece na tela e o teste não cria nada.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { ApiRequestError } from "@/lib/api";
import { NewProjectPage } from "@/pages/NewProjectPage";

const TOKEN = "ghp_TOKENdigitadoSUPERSECRETO0006";
const URL_REPO = "https://github.com/usuario/loja.git";
const OK = {
  ok: true,
  defaultBranch: "main",
  branches: ["main", "develop", "feature/x"],
  totalBranches: 3,
  branchFound: null,
  message: "x",
};

let accountConnected = false;
let resposta: unknown = OK;
let pendente: ((v: unknown) => void) | null = null;
let chamadasTeste: { path: string; body: Record<string, unknown> }[] = [];

beforeEach(() => {
  accountConnected = false;
  resposta = OK;
  pendente = null;
  chamadasTeste = [];
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (path === "/api/integrations/github" && method === "GET") {
      return accountConnected ? { connected: true, login: "kelvin", hint: "1234", updatedAt: "x" } : { connected: false };
    }
    if (path === "/api/integrations/github/repos") {
      return {
        repos: [
          { fullName: "kelvin/api-privada", private: true, cloneUrl: "https://github.com/kelvin/api-privada.git", htmlUrl: "", defaultBranch: "dev", description: null, updatedAt: "x" },
        ],
      };
    }
    if (path.startsWith("/api/domains/suggest")) return { auto: "loja.203-0-113-10.sslip.io", publicIp: "203.0.113.10" };
    if (path === "/api/projects/check-git-access" && method === "POST") {
      chamadasTeste.push({ path, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      if (pendente === null && resposta === "segurar") return new Promise((resolve) => (pendente = resolve));
      if (resposta instanceof Error) throw resposta;
      return resposta;
    }
    throw new Error(`chamada inesperada: ${method} ${path}`);
  });
});
afterEach(cleanup);

function abrirPrivado(url = URL_REPO) {
  render(
    <MemoryRouter>
      <NewProjectPage />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByPlaceholderText("minha-app"), { target: { value: "loja" } });
  fireEvent.click(screen.getByRole("button", { name: /Repositório Git/ }));
  fireEvent.change(screen.getByPlaceholderText("https://github.com/usuario/repo.git"), { target: { value: url } });
  fireEvent.click(screen.getByRole("checkbox", { name: /Repositório privado/ }));
}

const botao = () => screen.getByRole("button", { name: "Testar acesso" });
const resultado = () => screen.getByTestId("git-access-result");

describe("Testar acesso — token digitado", () => {
  it("o botão fica ao lado do campo do token e só habilita com endereço e token", () => {
    abrirPrivado();
    expect(botao()).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Token de leitura/), { target: { value: TOKEN } });
    expect(botao()).toBeEnabled();
    fireEvent.change(screen.getByPlaceholderText("https://github.com/usuario/repo.git"), { target: { value: "" } });
    expect(botao()).toBeDisabled();
  });

  it("envia endereço, branch e token; mostra carregando e depois a lista de branches (região role=status)", async () => {
    resposta = "segurar";
    abrirPrivado();
    fireEvent.change(screen.getByLabelText(/Token de leitura/), { target: { value: TOKEN } });
    fireEvent.click(botao());
    expect(await screen.findByText(/Testando o acesso/)).toBeInTheDocument();
    expect(resultado()).toHaveAttribute("role", "status");
    expect(botao()).toBeDisabled();
    expect(chamadasTeste).toEqual([{ path: "/api/projects/check-git-access", body: { source: URL_REPO, branch: "main", token: TOKEN } }]);

    pendente?.(OK);
    await waitFor(() => expect(resultado()).toHaveTextContent(/Acesso confirmado/));
    expect(resultado()).toHaveTextContent("main");
    expect(resultado()).toHaveTextContent("develop");
    expect(resultado()).toHaveTextContent("feature/x");
    expect(botao()).toBeEnabled();
  });

  it("o token nunca aparece na tela, nem no resultado", async () => {
    abrirPrivado();
    fireEvent.change(screen.getByLabelText(/Token de leitura/), { target: { value: TOKEN } });
    fireEvent.click(botao());
    await waitFor(() => expect(resultado()).toHaveTextContent(/Acesso confirmado/));
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it("branch pedida existe: diz que existe; lista longa mostra quantas faltam", async () => {
    resposta = { ...OK, totalBranches: 25, branchFound: true };
    abrirPrivado();
    fireEvent.change(screen.getByLabelText(/Token de leitura/), { target: { value: TOKEN } });
    fireEvent.click(botao());
    await waitFor(() => expect(resultado()).toHaveTextContent(/A branch main existe/));
    expect(resultado()).toHaveTextContent(/e mais 22/);
  });

  it("repositório vazio: confirma o acesso e avisa que não há branches", async () => {
    resposta = { ok: true, defaultBranch: null, branches: [], totalBranches: 0, branchFound: null, message: "x" };
    abrirPrivado();
    fireEvent.change(screen.getByLabelText(/Token de leitura/), { target: { value: TOKEN } });
    fireEvent.click(botao());
    await waitFor(() => expect(resultado()).toHaveTextContent(/vazio/));
  });

  it.each([
    ["invalid_token", /token.*(inválido|expirou)/i],
    ["auth_required", /pede autenticação/i],
    ["no_permission", /permissão de leitura/i],
    ["not_found", /não encontrado/i],
    ["not_found_or_no_access", /não enxerga/i],
    ["unsupported_host", /protocolo/i],
    ["unreachable", /falar com o servidor/i],
    ["timeout", /tempo esgotado/i],
    ["token_not_applicable", /https/i],
    ["invalid_source", /Endereço.*inválido/i],
    ["unknown", /não reconheceu/i],
  ])("motivo %s é explicado em português", async (reason, texto) => {
    resposta = { ok: false, reason, message: "mensagem do servidor" };
    abrirPrivado();
    fireEvent.change(screen.getByLabelText(/Token de leitura/), { target: { value: TOKEN } });
    fireEvent.click(botao());
    await waitFor(() => expect(resultado()).toHaveTextContent(texto));
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it("branch que não existe: lista as que existem e a padrão", async () => {
    resposta = { ok: false, reason: "branch_not_found", message: "x", defaultBranch: "main", branches: ["main", "develop"], totalBranches: 2 };
    abrirPrivado();
    fireEvent.change(screen.getByDisplayValue("main"), { target: { value: "naoexiste" } });
    fireEvent.change(screen.getByLabelText(/Token de leitura/), { target: { value: TOKEN } });
    fireEvent.click(botao());
    await waitFor(() => expect(resultado()).toHaveTextContent(/branch naoexiste não existe/));
    expect(resultado()).toHaveTextContent("develop");
    expect(resultado()).toHaveTextContent(/padrão.*main/i);
  });

  it("falha do pedido (limite de taxa, rede): mostra a mensagem do erro em vez de travar", async () => {
    resposta = new ApiRequestError(429, "rate_limited", "Muitas tentativas. Aguarde um minuto.");
    abrirPrivado();
    fireEvent.change(screen.getByLabelText(/Token de leitura/), { target: { value: TOKEN } });
    fireEvent.click(botao());
    await waitFor(() => expect(resultado()).toHaveTextContent(/Muitas tentativas/));
    expect(botao()).toBeEnabled();
  });

  it("mudar o token, o endereço ou a branch apaga o resultado antigo", async () => {
    abrirPrivado();
    const campo = screen.getByLabelText(/Token de leitura/);
    fireEvent.change(campo, { target: { value: TOKEN } });
    fireEvent.click(botao());
    await waitFor(() => expect(resultado()).toHaveTextContent(/Acesso confirmado/));
    fireEvent.change(campo, { target: { value: `${TOKEN}x` } });
    expect(resultado()).not.toHaveTextContent(/Acesso confirmado/);
    fireEvent.click(botao());
    await waitFor(() => expect(resultado()).toHaveTextContent(/Acesso confirmado/));
    fireEvent.change(screen.getByDisplayValue("main"), { target: { value: "develop" } });
    expect(resultado()).not.toHaveTextContent(/Acesso confirmado/);
  });

  it("o resultado não estoura em tela estreita (quebra palavras longas)", async () => {
    abrirPrivado();
    fireEvent.change(screen.getByLabelText(/Token de leitura/), { target: { value: TOKEN } });
    fireEvent.click(botao());
    await waitFor(() => expect(resultado()).toHaveTextContent(/Acesso confirmado/));
    expect(resultado().className).toMatch(/overflow-wrap:anywhere/);
    expect(botao().closest("div")?.className).toMatch(/flex-wrap/);
  });

  it("testar não cria o projeto: nenhuma chamada além da consulta", async () => {
    abrirPrivado();
    fireEvent.change(screen.getByLabelText(/Token de leitura/), { target: { value: TOKEN } });
    fireEvent.click(botao());
    await waitFor(() => expect(resultado()).toHaveTextContent(/Acesso confirmado/));
    const gravacoes = apiFetchMock.mock.calls.filter(([p, i]) => p === "/api/projects" || (i as RequestInit | undefined)?.method === "PUT");
    expect(gravacoes).toEqual([]);
  });
});

describe("Testar acesso — conta do GitHub conectada", () => {
  async function escolherPrivadoDaConta() {
    accountConnected = true;
    render(
      <MemoryRouter>
        <NewProjectPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Escolher dos meus repositórios/ }));
    fireEvent.click(await screen.findByRole("button", { name: /kelvin\/api-privada/ }));
  }

  it("depois de escolher um repositório privado da conta, o botão testa com o token da conta (sem token no corpo)", async () => {
    await escolherPrivadoDaConta();
    expect(screen.getByTestId("uses-account-token")).toBeInTheDocument();
    fireEvent.click(botao());
    await waitFor(() => expect(resultado()).toHaveTextContent(/Acesso confirmado/));
    expect(chamadasTeste).toEqual([
      { path: "/api/projects/check-git-access", body: { source: "https://github.com/kelvin/api-privada.git", branch: "dev", useAccount: true } },
    ]);
  });

  it("conta não conectada mais: mostra o motivo", async () => {
    resposta = { ok: false, reason: "account_not_connected", message: "x" };
    await escolherPrivadoDaConta();
    fireEvent.click(botao());
    await waitFor(() => expect(resultado()).toHaveTextContent(/Nenhuma conta do GitHub/));
  });

  it("repositório público escolhido da conta não mostra o botão", async () => {
    accountConnected = true;
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/integrations/github") return { connected: true, login: "kelvin", hint: "1", updatedAt: "x" };
      if (path === "/api/integrations/github/repos") {
        return { repos: [{ fullName: "kelvin/pub", private: false, cloneUrl: "https://github.com/kelvin/pub.git", htmlUrl: "", defaultBranch: "main", description: null, updatedAt: "x" }] };
      }
      if (path.startsWith("/api/domains/suggest")) return { auto: "x", publicIp: null };
      throw new Error(`chamada inesperada: ${init?.method ?? "GET"} ${path}`);
    });
    render(
      <MemoryRouter>
        <NewProjectPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Escolher dos meus repositórios/ }));
    fireEvent.click(await screen.findByRole("button", { name: /kelvin\/pub/ }));
    expect(screen.queryByRole("button", { name: "Testar acesso" })).not.toBeInTheDocument();
  });
});

describe("Testar acesso — em inglês", () => {
  it("todos os textos têm tradução (chaves em paridade com o pt-BR)", async () => {
    const pt = (await import("@/locales/pt-BR/projects")).default as Record<string, string>;
    const en = (await import("@/locales/en/projects")).default as Record<string, string>;
    const chaves = Object.keys(pt).filter((k) => k.startsWith("new.access."));
    expect(chaves.length).toBeGreaterThan(10);
    for (const k of chaves) expect(en[k], k).toBeTruthy();
  });
});
