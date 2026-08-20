/**
 * Testes do passo de boas-vindas do wizard de setup: renderização, validação
 * de token vazio (botão desabilitado), erro da API exibido ao usuário e
 * sucesso persistindo o token na sessão.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WelcomeStep } from "../src/pages/setup/WelcomeStep";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe("WelcomeStep (wizard de setup)", () => {
  it("renderiza o formulário com o botão desabilitado enquanto o token está vazio", () => {
    render(<WelcomeStep onVerified={() => undefined} />);
    expect(screen.getByText("Bem-vindo ao TWS Panel")).toBeInTheDocument();
    const button = screen.getByRole("button", { name: /validar token/i });
    expect(button).toBeDisabled();
  });

  it("habilita o botão quando o token é preenchido", async () => {
    const user = userEvent.setup();
    render(<WelcomeStep onVerified={() => undefined} />);
    const button = screen.getByRole("button", { name: /validar token/i });
    await user.type(screen.getByPlaceholderText(/cole aqui o setup token/i), "  tok  ");
    expect(button).toBeEnabled();
  });

  it("token válido → chama onVerified e persiste o token na sessão", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ valid: true }));
    vi.stubGlobal("fetch", fetchMock);
    const onVerified = vi.fn();
    const user = userEvent.setup();
    render(<WelcomeStep onVerified={onVerified} />);

    await user.type(screen.getByPlaceholderText(/cole aqui o setup token/i), "token-bom");
    await user.click(screen.getByRole("button", { name: /validar token/i }));

    expect(onVerified).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem("paas.setup-token")).toBe("token-bom");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/setup/verify-token");
    expect(JSON.parse(String(init?.body))).toEqual({ token: "token-bom" });
  });

  it("token inválido → exibe a mensagem de erro e NÃO avança", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ valid: false })));
    const onVerified = vi.fn();
    const user = userEvent.setup();
    render(<WelcomeStep onVerified={onVerified} />);

    await user.type(screen.getByPlaceholderText(/cole aqui o setup token/i), "token-ruim");
    await user.click(screen.getByRole("button", { name: /validar token/i }));

    expect(await screen.findByText(/token inválido/i)).toBeInTheDocument();
    expect(onVerified).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("paas.setup-token")).toBeNull();
  });

  it("erro da API (503 sem token no servidor) → exibe a mensagem da API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: "setup_token_missing", message: "Servidor sem setup token configurado." }, 503),
      ),
    );
    const user = userEvent.setup();
    render(<WelcomeStep onVerified={() => undefined} />);

    await user.type(screen.getByPlaceholderText(/cole aqui o setup token/i), "qualquer");
    await user.click(screen.getByRole("button", { name: /validar token/i }));

    expect(await screen.findByText("Servidor sem setup token configurado.")).toBeInTheDocument();
  });
});
