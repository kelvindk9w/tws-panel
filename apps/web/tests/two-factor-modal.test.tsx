/**
 * two-factor-modal.test.tsx — ativar e desativar a verificação em duas etapas.
 *
 * Para um leigo: dizer o que é e qual app instalar; QR code e a chave em texto
 * (para quem não consegue ler o QR); confirmar com o código + senha atual; os
 * códigos de recuperação aparecem UMA vez, com copiar/baixar, e só fecha
 * depois de marcar que guardou.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.fn();

vi.mock("@/lib/api", () => ({
  apiFetch: (path: string, init?: RequestInit) => apiFetchMock(path, init),
  ApiRequestError: class extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));

import { ApiRequestError } from "@/lib/api";
import { TwoFactorModal } from "@/components/TwoFactorModal";

const CODES = ["abcde-fghij", "kmnpq-rstuv", "wxyz2-34567", "a2b3c-d4e5f", "g6h7j-k8m9n", "pqrst-uvwxy", "z2345-6789a", "bcdef-ghjkm", "npqrs-tuvwx", "yz234-56789"];

let status = { enabled: false, recoveryCodesLeft: 0 };

beforeEach(() => {
  status = { enabled: false, recoveryCodesLeft: 0 };
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/auth/2fa") return status;
    if (path === "/api/auth/2fa/setup") {
      return { secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP", otpauthUri: "otpauth://totp/TWS%20Panel:admin?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP" };
    }
    if (path === "/api/auth/2fa/enable") {
      const body = JSON.parse(String(init?.body)) as { code: string };
      if (body.code !== "123456") throw new ApiRequestError(400, "invalid_two_factor_code", "Código incorreto.");
      return { recoveryCodes: CODES };
    }
    if (path === "/api/auth/2fa/disable") return { ok: true };
    throw new Error(`inesperado: ${path}`);
  });
});

afterEach(cleanup);

async function ateOQr() {
  render(<TwoFactorModal onClose={() => undefined} />);
  fireEvent.click(await screen.findByRole("button", { name: /Começar/ }));
  await screen.findByTestId("two-factor-qr");
}

describe("TwoFactorModal — desligada", () => {
  it("explica o que é e quais apps servem, antes de qualquer mudança", async () => {
    render(<TwoFactorModal onClose={() => undefined} />);
    const intro = await screen.findByTestId("two-factor-intro");
    expect(intro).toHaveTextContent(/código de 6 dígitos/i);
    expect(intro).toHaveTextContent(/Google Authenticator/);
    expect(intro).toHaveTextContent(/Microsoft Authenticator/);
    expect(apiFetchMock).not.toHaveBeenCalledWith("/api/auth/2fa/setup", expect.anything());
  });

  it("mostra o QR e a chave em texto para digitar à mão", async () => {
    await ateOQr();
    expect(screen.getByTestId("two-factor-qr").getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
    expect(screen.getByTestId("two-factor-secret")).toHaveTextContent("JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP");
  });

  it("código errado: mostra o erro e continua na mesma etapa", async () => {
    await ateOQr();
    fireEvent.change(screen.getByLabelText(/Código que aparece no app/), { target: { value: "000000" } });
    fireEvent.change(screen.getByLabelText(/Sua senha atual/), { target: { value: "MinhaSenha123" } });
    fireEvent.click(screen.getByRole("button", { name: /Ativar/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Código incorreto/);
    expect(screen.getByTestId("two-factor-qr")).toBeInTheDocument();
  });

  it("ativou: mostra os 10 códigos de recuperação e só deixa concluir depois de marcar que guardou", async () => {
    const onClose = vi.fn();
    render(<TwoFactorModal onClose={onClose} />);
    fireEvent.click(await screen.findByRole("button", { name: /Começar/ }));
    await screen.findByTestId("two-factor-qr");
    fireEvent.change(screen.getByLabelText(/Código que aparece no app/), { target: { value: "123456" } });
    fireEvent.change(screen.getByLabelText(/Sua senha atual/), { target: { value: "MinhaSenha123" } });
    fireEvent.click(screen.getByRole("button", { name: /Ativar/ }));

    const lista = await screen.findByTestId("recovery-codes");
    for (const c of CODES) expect(lista).toHaveTextContent(c);
    expect(screen.getByText(/só aparecem agora/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Baixar/ })).toBeInTheDocument();
    const concluir = screen.getByRole("button", { name: /Concluir/ });
    expect(concluir).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/Guardei os códigos/));
    expect(concluir).toBeEnabled();
    fireEvent.click(concluir);
    expect(onClose).toHaveBeenCalled();
    const body = JSON.parse(String(apiFetchMock.mock.calls.find((c) => c[0] === "/api/auth/2fa/enable")![1].body));
    expect(body).toEqual({ code: "123456", currentPassword: "MinhaSenha123" });
  });
});

describe("TwoFactorModal — ligada", () => {
  it("mostra o saldo de códigos (avisa quando está acabando) e desativa com senha + código", async () => {
    status = { enabled: true, recoveryCodesLeft: 2 };
    render(<TwoFactorModal onClose={() => undefined} />);
    expect(await screen.findByTestId("two-factor-on")).toHaveTextContent(/ativa/i);
    expect(screen.getByTestId("two-factor-on")).toHaveTextContent(/2 códigos de recuperação/);
    expect(screen.getByTestId("recovery-low")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Sua senha atual/), { target: { value: "MinhaSenha123" } });
    fireEvent.change(screen.getByLabelText(/Código que aparece no app/), { target: { value: "654321" } });
    fireEvent.click(screen.getByRole("button", { name: /Desativar/ }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith("/api/auth/2fa/disable", expect.objectContaining({ method: "POST" })),
    );
    expect(await screen.findByTestId("two-factor-intro")).toBeInTheDocument();
  });
});
