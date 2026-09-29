/**
 * new-project-page.test.tsx — assistente de novo projeto, passo 1 (fonte).
 *
 * Defeitos da validação real (29/09/2026):
 *  - repositório privado: não havia onde informar o token no assistente (só na
 *    página do projeto, depois de criado);
 *  - erro no passo 1 e nova tentativa criavam um SEGUNDO projeto;
 *  - a mensagem de erro do servidor (várias linhas, com a orientação do git)
 *    aparecia espremida numa linha só.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { NewProjectPage } from "@/pages/NewProjectPage";

const PROJECT = { id: "p1", domain: "cassino.localhost", name: "cassino" };
const DETECTION = {
  type: "dockerfile",
  composeFile: null,
  outputDir: null,
  packageManager: null,
  buildCommand: null,
  proxyService: null,
  proxyPort: 80,
  warnings: [],
  details: [],
};

let detectFailures = 0;

beforeEach(() => {
  detectFailures = 0;
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (path === "/api/projects" && method === "POST") return { project: PROJECT };
    if (path === "/api/projects/p1" && method === "PATCH") return { project: PROJECT };
    if (path === "/api/projects/p1/credential" && method === "PUT") return { credential: { configured: true } };
    if (path === "/api/projects/p1/detect") {
      if (detectFailures > 0) {
        detectFailures -= 1;
        const { ApiRequestError } = await import("@/lib/api");
        throw new ApiRequestError(
          422,
          "Unprocessable",
          "Não foi possível baixar o código do repositório.\n\ngit clone falhou: Authentication failed",
        );
      }
      return { detection: DETECTION };
    }
    throw new Error(`chamada inesperada: ${method} ${path}`);
  });
});

afterEach(cleanup);

function preencherGit() {
  render(
    <MemoryRouter>
      <NewProjectPage />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByPlaceholderText("minha-app"), { target: { value: "cassino" } });
  fireEvent.click(screen.getByRole("button", { name: /Repositório Git/ }));
  fireEvent.change(screen.getByPlaceholderText("https://github.com/usuario/repo.git"), {
    target: { value: "https://github.com/usuario/cassino" },
  });
}

function chamadas(): string[] {
  return apiFetchMock.mock.calls.map(([p, init]) => `${(init as RequestInit | undefined)?.method ?? "GET"} ${p}`);
}

describe("NewProjectPage — repositório git", () => {
  it("público: cria e detecta, sem pedir credencial", async () => {
    preencherGit();
    expect(screen.queryByLabelText(/Token de leitura/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Criar e detectar/ }));
    await screen.findByText(/Tipo detectado/);
    expect(chamadas()).toEqual(["POST /api/projects", "POST /api/projects/p1/detect"]);
  });

  it("privado: o token vai para a credencial ANTES de baixar o código, e não fica na tela", async () => {
    preencherGit();
    fireEvent.click(screen.getByRole("checkbox", { name: /Repositório privado/ }));
    expect(screen.getByText(/somente leitura/i)).toBeInTheDocument();
    const token = screen.getByLabelText(/Token de leitura/) as HTMLInputElement;
    expect(token).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "Mostrar token" })).toBeInTheDocument();
    fireEvent.change(token, { target: { value: "tok-fake-de-teste-123" } });

    fireEvent.click(screen.getByRole("button", { name: /Criar e detectar/ }));
    await waitFor(() => expect(chamadas()).toContain("POST /api/projects/p1/detect"));
    expect(chamadas()).toEqual([
      "POST /api/projects",
      "PUT /api/projects/p1/credential",
      "POST /api/projects/p1/detect",
    ]);
    const put = apiFetchMock.mock.calls.find(([p]) => p === "/api/projects/p1/credential");
    expect(JSON.parse(String((put?.[1] as RequestInit).body))).toEqual({ token: "tok-fake-de-teste-123" });
    expect(document.body.textContent).not.toContain("tok-fake-de-teste-123");
  });

  it("erro ao baixar: mensagem completa (várias linhas) e nova tentativa NÃO cria outro projeto", async () => {
    detectFailures = 1;
    preencherGit();
    fireEvent.click(screen.getByRole("button", { name: /Criar e detectar/ }));
    const erro = await screen.findByTestId("new-project-error");
    expect(erro).toHaveTextContent(/Não foi possível baixar o código/);
    expect(erro).toHaveTextContent(/Authentication failed/);
    expect(erro.className).toContain("whitespace-pre-line");

    // corrige a URL e tenta de novo
    fireEvent.change(screen.getByPlaceholderText("https://github.com/usuario/repo.git"), {
      target: { value: "https://github.com/usuario/cassino.git" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Tentar de novo/ }));
    await waitFor(() => expect(chamadas().filter((c) => c.endsWith("/detect"))).toHaveLength(2));
    expect(chamadas().filter((c) => c === "POST /api/projects")).toHaveLength(1);
    const patch = apiFetchMock.mock.calls.find(([p, i]) => p === "/api/projects/p1" && (i as RequestInit).method === "PATCH");
    expect(JSON.parse(String((patch?.[1] as RequestInit).body))).toMatchObject({
      name: "cassino",
      source: "https://github.com/usuario/cassino.git",
      branch: "main",
    });
  });
});
