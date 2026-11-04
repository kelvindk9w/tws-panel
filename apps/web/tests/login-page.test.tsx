/**
 * Testes da página de login: submit chama a API com as credenciais, erro 401
 * exibe "Credenciais inválidas", 429 exibe o aviso de espera e o sucesso
 * redireciona para o destino original salvo pelo guard.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoginPage } from "../src/pages/LoginPage";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Mostra a rota atual para afirmar o redirecionamento pós-login. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderLogin(initialPath = "/login", state?: { from: string }) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: initialPath, state }]}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe("LoginPage", () => {
  it("botão desabilitado enquanto os campos estão vazios", () => {
    renderLogin();
    expect(screen.getByRole("button", { name: /^entrar$/i })).toBeDisabled();
  });

  it("sucesso → envia credenciais corretas e redireciona para o destino original", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ ok: true, user: { username: "admin", createdAt: "x" }, expiresAt: "y" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderLogin("/login", { from: "/security" });

    await user.type(screen.getByLabelText(/usuário/i), "admin");
    await user.type(screen.getByLabelText(/^senha$/i), "MinhaSenha123");
    await user.click(screen.getByRole("button", { name: /^entrar$/i }));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/auth/login");
    expect(JSON.parse(String(init?.body))).toEqual({ username: "admin", password: "MinhaSenha123" });

    // resultado real: voltou para a página que tentava acessar
    const probes = screen.getAllByTestId("location");
    await waitFor(() => expect(probes.some((p) => p.textContent === "/security")).toBe(true));
  });

  it("401 → exibe 'Credenciais inválidas.' e permanece na tela de login", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "invalid_credentials", message: "Credenciais inválidas." }, 401)),
    );
    const user = userEvent.setup();
    renderLogin();

    await user.type(screen.getByLabelText(/usuário/i), "admin");
    await user.type(screen.getByLabelText(/^senha$/i), "errada");
    await user.click(screen.getByRole("button", { name: /^entrar$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Credenciais inválidas.");
    const probes = screen.getAllByTestId("location");
    expect(probes.some((p) => p.textContent === "/login")).toBe(true);
  });

  it("429 → exibe o aviso de muitas tentativas retornado pela API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { error: "too_many_attempts", message: "Muitas tentativas. Aguarde 60s e tente novamente.", retryAfterSec: 60 },
          429,
        ),
      ),
    );
    const user = userEvent.setup();
    renderLogin();

    await user.type(screen.getByLabelText(/usuário/i), "admin");
    await user.type(screen.getByLabelText(/^senha$/i), "errada");
    await user.click(screen.getByRole("button", { name: /^entrar$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/muitas tentativas/i);
  });

  it("durante o envio mostra estado de loading e impede duplo submit", async () => {
    let resolveFetch: ((r: Response) => void) | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; })),
    );
    const user = userEvent.setup();
    renderLogin();

    await user.type(screen.getByLabelText(/usuário/i), "admin");
    await user.type(screen.getByLabelText(/^senha$/i), "MinhaSenha123");
    await user.click(screen.getByRole("button", { name: /^entrar$/i }));

    expect(await screen.findByRole("button", { name: /entrando/i })).toBeDisabled();
    resolveFetch?.(jsonResponse({ ok: true, user: { username: "admin", createdAt: "x" }, expiresAt: "y" }));
  });
});

/**
 * Verificação em duas etapas: a senha certa responde two_factor_required; a
 * tela pede o código do app SEM apagar o que já foi digitado e reenvia tudo.
 */
describe("LoginPage — verificação em duas etapas", () => {
  it("pede o código depois da senha e entra com ele", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { code?: string };
      if (!body.code) {
        return jsonResponse({ error: "two_factor_required", message: "Digite o código de 6 dígitos do seu app autenticador." }, 401);
      }
      return jsonResponse({ ok: true, user: { username: "admin", createdAt: "x" }, expiresAt: "y" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderLogin("/login", { from: "/security" });

    await user.type(screen.getByLabelText(/usuário/i), "admin");
    await user.type(screen.getByLabelText(/^senha$/i), "MinhaSenha123");
    await user.click(screen.getByRole("button", { name: /^entrar$/i }));

    const campo = await screen.findByLabelText(/código de verificação/i);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(); // não é erro: é o próximo passo
    expect(screen.getByText(/app autenticador/i)).toBeInTheDocument();
    await user.type(campo, "123 456");
    await user.click(screen.getByRole("button", { name: /^entrar$/i }));

    await waitFor(() => expect(screen.getAllByTestId("location")[0]).toHaveTextContent("/security"));
    const ultimo = JSON.parse(String((fetchMock.mock.calls.at(-1)![1] as RequestInit).body));
    expect(ultimo).toEqual({ username: "admin", password: "MinhaSenha123", code: "123 456" });
  });

  it("código errado mostra o erro e mantém o campo do código", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { code?: string };
        return body.code
          ? jsonResponse({ error: "invalid_two_factor_code", message: "Código incorreto ou já usado." }, 401)
          : jsonResponse({ error: "two_factor_required", message: "Digite o código." }, 401);
      }),
    );
    const user = userEvent.setup();
    renderLogin();
    await user.type(screen.getByLabelText(/usuário/i), "admin");
    await user.type(screen.getByLabelText(/^senha$/i), "MinhaSenha123");
    await user.click(screen.getByRole("button", { name: /^entrar$/i }));
    await user.type(await screen.findByLabelText(/código de verificação/i), "000000");
    await user.click(screen.getByRole("button", { name: /^entrar$/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Código incorreto/);
    expect(screen.getByLabelText(/código de verificação/i)).toBeInTheDocument();
    expect(screen.getByText(/códigos? de recuperação/i)).toBeInTheDocument();
  });
});
