/**
 * Testes da página de login: submit chama a API com as credenciais, erro 401
 * exibe "Credenciais inválidas", 429 exibe o aviso de espera e o sucesso
 * redireciona para o destino original salvo pelo guard.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
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
    await user.type(screen.getByLabelText(/senha/i), "MinhaSenha123");
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
    await user.type(screen.getByLabelText(/senha/i), "errada");
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
    await user.type(screen.getByLabelText(/senha/i), "errada");
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
    await user.type(screen.getByLabelText(/senha/i), "MinhaSenha123");
    await user.click(screen.getByRole("button", { name: /^entrar$/i }));

    expect(await screen.findByRole("button", { name: /entrando/i })).toBeDisabled();
    resolveFetch?.(jsonResponse({ ok: true, user: { username: "admin", createdAt: "x" }, expiresAt: "y" }));
  });
});
