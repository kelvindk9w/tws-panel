/**
 * two-factor-nudge.test.tsx — aviso no Dashboard enquanto a verificação em duas
 * etapas estiver desligada: o painel fica na internet (HTTPS) e só a senha o
 * protege. Some quando ativa; e não aparece se não deu para saber.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.fn();
vi.mock("@/lib/api", () => ({
  apiFetch: (path: string, init?: RequestInit) => apiFetchMock(path, init),
  ApiRequestError: class extends Error {},
}));

import { TwoFactorNudge } from "@/components/TwoFactorNudge";

beforeEach(() => {
  apiFetchMock.mockReset();
});
afterEach(cleanup);

describe("TwoFactorNudge", () => {
  it("desligada: recomenda ativar e leva a Configurações → Segurança", async () => {
    apiFetchMock.mockResolvedValue({ enabled: false, recoveryCodesLeft: 0 });
    render(<TwoFactorNudge />, { wrapper: MemoryRouter });
    const aviso = await screen.findByTestId("two-factor-nudge");
    expect(aviso).toHaveTextContent(/só pela senha/i);
    expect(screen.getByRole("link", { name: /Ativar agora/ })).toHaveAttribute("href", "/settings/security#two-factor");
  });

  it("ligada: nenhum aviso", async () => {
    apiFetchMock.mockResolvedValue({ enabled: true, recoveryCodesLeft: 10 });
    render(<TwoFactorNudge />, { wrapper: MemoryRouter });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("two-factor-nudge")).not.toBeInTheDocument();
  });

  it("sem resposta do servidor: nenhum aviso", async () => {
    apiFetchMock.mockImplementation(async () => {
      throw new Error("rede");
    });
    render(<TwoFactorNudge />, { wrapper: MemoryRouter });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("two-factor-nudge")).not.toBeInTheDocument();
  });
});
