/**
 * github-integration-ui.test.tsx — conectar a conta do GitHub (Configurações →
 * Integrações) e escolher o repositório numa lista no Novo Projeto.
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
import { IntegrationSettings } from "@/pages/settings/IntegrationSettings";
import { NewProjectPage } from "@/pages/NewProjectPage";

let connected = false;

beforeEach(() => {
  connected = false;
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (path === "/api/integrations/github" && method === "GET") {
      return connected
        ? { connected: true, login: "kelvin", hint: "1234", updatedAt: "2026-09-30T10:00:00Z" }
        : { connected: false, login: null, hint: null, updatedAt: null };
    }
    if (path === "/api/integrations/github" && method === "PUT") {
      const { token } = JSON.parse(String(init?.body)) as { token: string };
      if (token.startsWith("ghp_")) {
        throw new ApiRequestError(400, "github_token_can_write", "Este token dá permissão de ESCRITA nos repositórios (repo).");
      }
      connected = true;
      return { connected: true, login: "kelvin", hint: "1234", updatedAt: "x" };
    }
    if (path === "/api/integrations/github" && method === "DELETE") {
      connected = false;
      return { ok: true };
    }
    if (path === "/api/integrations/github/repos") {
      return {
        repos: [
          { fullName: "kelvin/devlinks", private: false, cloneUrl: "https://github.com/kelvin/devlinks.git", htmlUrl: "", defaultBranch: "main", description: "Links", updatedAt: "x" },
          { fullName: "kelvin/api-privada", private: true, cloneUrl: "https://github.com/kelvin/api-privada.git", htmlUrl: "", defaultBranch: "dev", description: null, updatedAt: "x" },
        ],
      };
    }
    throw new Error(`chamada inesperada: ${method} ${path}`);
  });
});
afterEach(cleanup);

describe("Configurações → Integrações", () => {
  it("conecta com o token, mostra a conta e desconecta", async () => {
    render(<IntegrationSettings />, { wrapper: MemoryRouter });
    fireEvent.change(await screen.findByLabelText(/Token do GitHub/), { target: { value: "github_pat_x1234" } });
    fireEvent.click(screen.getByRole("button", { name: /^Conectar$/ }));
    expect(await screen.findByTestId("github-connected")).toHaveTextContent("kelvin");
    fireEvent.click(screen.getByRole("button", { name: /Desconectar/ }));
    expect(await screen.findByLabelText(/Token do GitHub/)).toBeInTheDocument();
  });

  it("token com permissão de escrita: mostra o motivo da recusa", async () => {
    render(<IntegrationSettings />, { wrapper: MemoryRouter });
    fireEvent.change(await screen.findByLabelText(/Token do GitHub/), { target: { value: "ghp_classico" } });
    fireEvent.click(screen.getByRole("button", { name: /^Conectar$/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/ESCRITA/);
  });

  it("o guia do token é o da conta (todos os repositórios ou os escolhidos, só leitura)", async () => {
    render(<IntegrationSettings />, { wrapper: MemoryRouter });
    fireEvent.click(await screen.findByRole("button", { name: /Como gerar o token/ }));
    const guia = screen.getByTestId("token-guide");
    expect(guia).toHaveTextContent(/All repositories/);
    expect(guia).toHaveTextContent(/Read-only/);
  });
});

describe("Novo Projeto — escolher dos meus repositórios", () => {
  function abrir() {
    render(
      <MemoryRouter>
        <NewProjectPage />
      </MemoryRouter>,
    );
  }

  it("sem conta conectada: convida a conectar", async () => {
    abrir();
    expect(await screen.findByRole("link", { name: /Conectar minha conta do GitHub/ })).toHaveAttribute("href", "/settings/integrations");
  });

  it("com conta conectada: lista, filtra e preencher URL e branch; privado não pede token de novo", async () => {
    connected = true;
    abrir();
    fireEvent.click(await screen.findByRole("button", { name: /Escolher dos meus repositórios/ }));
    fireEvent.change(await screen.findByPlaceholderText(/Buscar repositório/), { target: { value: "api" } });
    expect(screen.queryByRole("button", { name: /kelvin\/devlinks/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /kelvin\/api-privada/ }));
    expect(screen.getByPlaceholderText("https://github.com/usuario/repo.git")).toHaveValue("https://github.com/kelvin/api-privada.git");
    expect(screen.getByDisplayValue("dev")).toBeInTheDocument();
    expect(screen.getByTestId("uses-account-token")).toHaveTextContent(/conta do GitHub conectada/);
    expect(screen.queryByLabelText(/Token de leitura/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("minha-app"), { target: { value: "api" } });
    await waitFor(() => expect(screen.getByRole("button", { name: /Criar e detectar/ })).toBeEnabled());
  });
});
