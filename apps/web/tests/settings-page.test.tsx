/**
 * settings-page.test.tsx — Configurações → Aparência → Menu de navegação.
 * Escolher vale na hora (o painel muda sem recarregar) e fica salvo na conta;
 * se o servidor recusar, volta ao que era e diz por quê.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserPreferences } from "@paas/core";

const apiFetchMock = vi.fn();
vi.mock("@/lib/api", () => ({
  apiFetch: (path: string, init?: RequestInit) => apiFetchMock(path, init),
  ApiRequestError: class extends Error {},
}));

import { AuthContext } from "@/lib/auth";
import { SettingsPage } from "@/pages/SettingsPage";

function Harness() {
  const [preferences, setPreferences] = useState<UserPreferences>({ navLayout: "top" });
  return (
    <MemoryRouter>
      <AuthContext.Provider value={{ user: { username: "admin", createdAt: "x" }, preferences, setPreferences }}>
        <SettingsPage />
        <p data-testid="atual">{preferences.navLayout}</p>
      </AuthContext.Provider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  apiFetchMock.mockReset();
});
afterEach(cleanup);

describe("SettingsPage — menu de navegação", () => {
  it("mostra as três opções com a atual marcada", () => {
    render(<Harness />);
    expect(screen.getByRole("radio", { name: /Topo/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Lateral esquerda/ })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: /Lateral direita/ })).not.toBeChecked();
  });

  it("escolher a lateral esquerda: muda na hora e salva na conta", async () => {
    apiFetchMock.mockResolvedValue({ preferences: { navLayout: "left" } });
    render(<Harness />);
    fireEvent.click(screen.getByRole("radio", { name: /Lateral esquerda/ }));
    expect(screen.getByTestId("atual")).toHaveTextContent("left");
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/api/settings/preferences",
        expect.objectContaining({ method: "PUT", body: JSON.stringify({ navLayout: "left" }) }),
      ),
    );
    expect(await screen.findByText(/Salvo/)).toBeInTheDocument();
  });

  it("servidor recusou: volta ao que era e avisa", async () => {
    apiFetchMock.mockRejectedValue(new Error("rede"));
    render(<Harness />);
    fireEvent.click(screen.getByRole("radio", { name: /Lateral direita/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Não foi possível salvar/);
    expect(screen.getByTestId("atual")).toHaveTextContent("top");
  });
});
