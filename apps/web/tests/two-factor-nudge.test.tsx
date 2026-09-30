/**
 * two-factor-nudge.test.tsx — aviso no Dashboard enquanto a verificação em duas
 * etapas estiver desligada: o painel fica na internet (HTTPS) e só a senha o
 * protege. Some quando ativa; e não aparece se não deu para saber.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  it("desligada: recomenda ativar e abre a configuração", async () => {
    apiFetchMock.mockResolvedValue({ enabled: false, recoveryCodesLeft: 0 });
    render(<TwoFactorNudge />);
    const aviso = await screen.findByTestId("two-factor-nudge");
    expect(aviso).toHaveTextContent(/só pela senha/i);
    fireEvent.click(screen.getByRole("button", { name: /Ativar agora/ }));
    expect(await screen.findByRole("dialog")).toHaveTextContent(/Verificação em duas etapas/);
  });

  it("ligada: nenhum aviso", async () => {
    apiFetchMock.mockResolvedValue({ enabled: true, recoveryCodesLeft: 10 });
    render(<TwoFactorNudge />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("two-factor-nudge")).not.toBeInTheDocument();
  });

  it("sem resposta do servidor: nenhum aviso", async () => {
    apiFetchMock.mockImplementation(async () => {
      throw new Error("rede");
    });
    render(<TwoFactorNudge />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("two-factor-nudge")).not.toBeInTheDocument();
  });
});
