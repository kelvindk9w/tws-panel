/**
 * user-menu.test.tsx — "Sair" só se apresenta como concluído quando o servidor
 * confirma o encerramento da sessão (achado 6 da revisão). Quando a gravação
 * da revogação falha, o servidor responde 500 storage_write_failed e mantém a
 * sessão e o cookie: a tela não pode navegar para o login como se tivesse
 * saído — mostra o erro e deixa tentar de novo.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
const clearSetupToken = vi.fn();

vi.mock("@/lib/api", () => {
  class ApiRequestError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    apiFetch: (...args: unknown[]) => apiFetch(...args),
    clearSetupToken: () => clearSetupToken(),
    ApiRequestError,
  };
});

import { ApiRequestError } from "@/lib/api";
import { AuthContext } from "@/lib/auth";
import { UserMenu } from "@/components/UserMenu";

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
  clearSetupToken.mockReset();
});

function renderMenu() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <AuthContext.Provider
        value={{
          user: { username: "admin", createdAt: "x" },
          setUser: () => undefined,
          preferences: { navLayout: "top" },
          setPreferences: () => undefined,
        }}
      >
        <Routes>
          <Route path="/" element={<UserMenu />} />
          <Route path="/login" element={<p>tela de login</p>} />
        </Routes>
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

async function clicarSair() {
  fireEvent.click(screen.getByRole("button", { name: /Conta: admin/ }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Sair/ }));
  });
}

const FALHA_GRAVACAO = "Não foi possível salvar o encerramento da sessão no servidor. Nada foi alterado.";

describe("UserMenu — sair", () => {
  it("servidor confirmou: limpa o token e vai para o login", async () => {
    apiFetch.mockResolvedValueOnce({ ok: true });
    renderMenu();
    await clicarSair();
    await waitFor(() => expect(screen.getByText("tela de login")).toBeInTheDocument());
    expect(clearSetupToken).toHaveBeenCalledTimes(1);
  });

  it("servidor recusou (500 storage_write_failed): NÃO finge que saiu, mostra o erro e deixa tentar de novo", async () => {
    apiFetch.mockRejectedValueOnce(new ApiRequestError(500, "storage_write_failed", FALHA_GRAVACAO));
    renderMenu();
    await clicarSair();

    expect(screen.queryByText("tela de login")).not.toBeInTheDocument();
    expect(clearSetupToken).not.toHaveBeenCalled();
    const alerta = screen.getByRole("alert");
    expect(alerta).toHaveTextContent("Você continua conectado");
    expect(alerta).toHaveTextContent(FALHA_GRAVACAO);

    // segunda tentativa, agora com sucesso
    apiFetch.mockResolvedValueOnce({ ok: true });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Tentar sair de novo/ }));
    });
    await waitFor(() => expect(screen.getByText("tela de login")).toBeInTheDocument());
  });

  it("sem conexão com o servidor: também não finge que saiu", async () => {
    apiFetch.mockRejectedValueOnce(new ApiRequestError(0, "network_error", "Não foi possível conectar ao servidor."));
    renderMenu();
    await clicarSair();
    expect(screen.queryByText("tela de login")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Não foi possível conectar ao servidor.");
  });

  it("sessão que já não valia (401): sair é verdade — vai para o login", async () => {
    apiFetch.mockRejectedValueOnce(new ApiRequestError(401, "unauthorized", "Sessão inválida ou expirada."));
    renderMenu();
    await clicarSair();
    await waitFor(() => expect(screen.getByText("tela de login")).toBeInTheDocument());
  });

  it("erro que não é da API: mensagem genérica, sem sair", async () => {
    apiFetch.mockRejectedValueOnce(new Error("boom"));
    renderMenu();
    await clicarSair();
    expect(screen.getByRole("alert")).toHaveTextContent("Você continua conectado");
    expect(screen.queryByText("tela de login")).not.toBeInTheDocument();
  });
});
