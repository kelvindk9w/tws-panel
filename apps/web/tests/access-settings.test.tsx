/**
 * access-settings.test.tsx — Configurações → Acesso à VPS e o código por e-mail.
 *
 * Para um leigo: ver as chaves SSH, adicionar e remover (sempre com senha + código do app),
 * trocar a senha do usuário Linux, desbloquear um IP e gerar o kit de recuperação sem segredos.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
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
import { AccessSettings } from "@/pages/settings/AccessSettings";
import { EmailCodeSettings } from "@/components/settings/EmailCodeSettings";
import { kitText } from "@/lib/recovery-kit";

const KEY = { fingerprint: "SHA256:abc", type: "ssh-ed25519", comment: "notebook", bits: 256, hasOptions: false };
const KEY2 = { fingerprint: "SHA256:def", type: "ssh-rsa", comment: "", bits: 3072, hasOptions: true };

let access: Record<string, unknown>;
let emailStatus: Record<string, unknown>;
let calls: Array<{ path: string; body: Record<string, unknown> }>;

beforeEach(() => {
  calls = [];
  access = { available: true, user: "ubuntu", twoFactorEnabled: true, keys: [KEY, KEY2], keysError: null, reason: null };
  emailStatus = {
    enabled: false,
    enabledAt: null,
    twoFactorEnabled: true,
    address: "a***@example.com",
    hostedHere: false,
    mailReady: true,
    mailReason: null,
    canEnable: true,
  };
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (init?.method === "POST") calls.push({ path, body });
    if (path === "/api/auth/email-code") return emailStatus;
    if (path === "/api/auth/email-code/send") return { sentTo: "a***@example.com", expiresInSec: 600, resendAfterSec: 30 };
    if (path === "/api/auth/email-code/enable") return { ...emailStatus, enabled: true, enabledAt: "2026-10-27T10:00:00Z" };
    if (path === "/api/auth/email-code/disable") return { ...emailStatus, enabled: false };
    if (path === "/api/security/access") return access;
    if (path === "/api/security/access/keys") return { keys: [KEY, KEY2, { ...KEY, fingerprint: "SHA256:new" }] };
    if (path === "/api/security/access/keys/remove") {
      if (body.code === "000000") throw new ApiRequestError(400, "invalid_two_factor_code", "Código errado.");
      return { keys: [KEY] };
    }
    if (path === "/api/security/access/linux-password") return { ok: true };
    if (path === "/api/security/access/bans") {
      return { available: true, reason: null, yourIp: "203.0.113.7", jails: [{ jail: "sshd", ips: ["203.0.113.7", "203.0.113.9"] }] };
    }
    if (path === "/api/security/access/bans/unban") return { available: true, reason: null, yourIp: "203.0.113.7", jails: [{ jail: "sshd", ips: ["203.0.113.9"] }] };
    if (path === "/api/security/access/kit") {
      return {
        generatedAt: "2026-10-27T10:00:00Z",
        panelAddress: "painel.example.com",
        panelAddressIp: "203.0.113.5",
        linuxUser: "ubuntu",
        sshPort: 22,
        keys: [KEY, KEY2],
        hostKeys: ["SHA256:host"],
        recoveryCodesLeft: 8,
        emailCodeEnabled: true,
        installDir: "/opt/tws-panel",
      };
    }
    throw new Error(`inesperado: ${path}`);
  });
});

afterEach(cleanup);

function fill(prefix: string, password = "senha-do-painel", code = "123456") {
  fireEvent.change(document.getElementById(`${prefix}-password`) as HTMLInputElement, { target: { value: password } });
  fireEvent.change(document.getElementById(`${prefix}-code`) as HTMLInputElement, { target: { value: code } });
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <AccessSettings />
    </MemoryRouter>,
  );

describe("AccessSettings", () => {
  it("lista as chaves e o usuário", async () => {
    renderPage();
    expect(await screen.findByTestId("ssh-keys")).toBeTruthy();
    expect(screen.getByText("SHA256:abc")).toBeTruthy();
    expect(screen.getByText(/Usuário de administração da VPS: ubuntu/)).toBeTruthy();
  });

  it("avisa quando indisponível e não mostra chaves", async () => {
    access = { available: false, user: null, twoFactorEnabled: true, keys: [], keysError: null, reason: "sem usuário" };
    renderPage();
    expect(await screen.findByText(/sem usuário/)).toBeTruthy();
    expect(screen.queryByTestId("ssh-keys")).toBeNull();
  });

  it("avisa em destaque quando a janela de SSH por senha está aberta", async () => {
    access = { ...access, passwordWindow: { open: true, expiresAt: "2026-10-27T12:15:00Z" } };
    renderPage();
    expect(await screen.findByText(/janela de recuperação \(SSH por senha\) está ABERTA e fecha às/)).toBeTruthy();
    cleanup();
    access = { ...access, passwordWindow: { open: true, expiresAt: null } };
    renderPage();
    expect(await screen.findByText(/está ABERTA\. Se não foi você/)).toBeTruthy();
  });

  it("avisa que precisa de 2FA", async () => {
    access = { ...access, twoFactorEnabled: false };
    renderPage();
    expect(await screen.findByText(/verificação em duas etapas ligada/)).toBeTruthy();
  });

  it("mostra erro de leitura", async () => {
    apiFetchMock.mockRejectedValueOnce(new ApiRequestError(500, "x", "Falhou ao ler."));
    renderPage();
    expect(await screen.findByText("Falhou ao ler.")).toBeTruthy();
  });

  it("adiciona uma chave com senha e código", async () => {
    renderPage();
    await screen.findByTestId("ssh-keys");
    fireEvent.change(document.getElementById("ak-key") as HTMLTextAreaElement, { target: { value: "ssh-ed25519 AAAA nova" } });
    fill("ak");
    fireEvent.click(screen.getByRole("button", { name: /Adicionar chave/ }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/security/access/keys")).toBe(true));
    const sent = calls.find((c) => c.path === "/api/security/access/keys")!.body;
    expect(sent).toMatchObject({ currentPassword: "senha-do-painel", code: "123456", publicKey: "ssh-ed25519 AAAA nova" });
    expect(await screen.findByText(/Chave adicionada/)).toBeTruthy();
  });

  it("remove uma chave e mostra o erro quando o código está errado", async () => {
    renderPage();
    await screen.findByTestId("ssh-keys");
    fireEvent.click(screen.getAllByRole("button", { name: "Remover" })[0]!);
    const form = await screen.findByTestId("remove-key-form");
    expect(form).toBeTruthy();
    fill("rk", "senha", "000000");
    fireEvent.click(screen.getByRole("button", { name: /Remover esta chave/ }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    fill("rk", "senha", "123456");
    fireEvent.click(screen.getByRole("button", { name: /Remover esta chave/ }));
    expect(await screen.findByText(/Chave removida/)).toBeTruthy();
  });

  it("cancela a remoção", async () => {
    renderPage();
    await screen.findByTestId("ssh-keys");
    fireEvent.click(screen.getAllByRole("button", { name: "Remover" })[0]!);
    await screen.findByTestId("remove-key-form");
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByTestId("remove-key-form")).toBeNull();
  });

  it("troca a senha do Linux só com as duas iguais e fortes", async () => {
    renderPage();
    await screen.findByTestId("ssh-keys");
    const btn = screen.getByRole("button", { name: /Trocar a senha na VPS/ });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(document.getElementById("lp-new") as HTMLInputElement, { target: { value: "uma-senha-bem-longa-1" } });
    fireEvent.change(document.getElementById("lp-again") as HTMLInputElement, { target: { value: "diferente" } });
    expect(screen.getByText(/não são iguais/)).toBeTruthy();
    fireEvent.change(document.getElementById("lp-again") as HTMLInputElement, { target: { value: "uma-senha-bem-longa-1" } });
    fill("lp");
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(btn);
    await waitFor(() => expect(calls.some((c) => c.path === "/api/security/access/linux-password")).toBe(true));
    expect(await screen.findByText(/trocada na VPS/)).toBeTruthy();
  });

  it("mostra erro ao trocar a senha", async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/api/security/access") return access;
      if (path === "/api/security/access/bans") return { available: false, reason: "fail2ban ausente", yourIp: null, jails: [] };
      throw new ApiRequestError(400, "weak_linux_password", "Senha fraca.");
    });
    renderPage();
    await screen.findByTestId("ssh-keys");
    expect(await screen.findByText(/fail2ban ausente/)).toBeTruthy();
    fireEvent.change(document.getElementById("lp-new") as HTMLInputElement, { target: { value: "uma-senha-bem-longa-1" } });
    fireEvent.change(document.getElementById("lp-again") as HTMLInputElement, { target: { value: "uma-senha-bem-longa-1" } });
    fill("lp");
    fireEvent.click(screen.getByRole("button", { name: /Trocar a senha na VPS/ }));
    expect(await screen.findByText("Senha fraca.")).toBeTruthy();
  });

  it("lista IPs bloqueados, marca o seu e desbloqueia", async () => {
    renderPage();
    const list = await screen.findByTestId("bans");
    expect(list.textContent).toContain("203.0.113.7");
    expect(screen.getByText("este é o seu IP")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Desbloquear" })[1]!);
    await screen.findByTestId("unban-form");
    fill("ub");
    fireEvent.click(screen.getAllByRole("button", { name: "Desbloquear" }).at(-1)!);
    await waitFor(() => expect(calls.some((c) => c.path === "/api/security/access/bans/unban")).toBe(true));
    expect(calls.find((c) => c.path.endsWith("/unban"))!.body.ip).toBe("203.0.113.9");
    expect(await screen.findByText(/203\.0\.113\.9 desbloqueado/)).toBeTruthy();
  });

  it("gera o kit de recuperação e oferece imprimir e baixar", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    renderPage();
    await screen.findByTestId("ssh-keys");
    fill("kit");
    fireEvent.click(screen.getByRole("button", { name: /Gerar o kit/ }));
    const pre = await screen.findByTestId("kit-text");
    expect(pre.textContent).toContain("painel.example.com");
    expect(pre.textContent).toContain("recuperar-acesso.sh");
    fireEvent.click(screen.getByRole("button", { name: /Imprimir/ }));
    expect(open).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Baixar/ }));
    expect(URL.createObjectURL).toHaveBeenCalled();
    open.mockRestore();
  });

  it("erro ao gerar o kit", async () => {
    renderPage();
    await screen.findByTestId("ssh-keys");
    apiFetchMock.mockRejectedValueOnce(new ApiRequestError(401, "invalid_current_password", "Senha incorreta."));
    fill("kit");
    fireEvent.click(screen.getByRole("button", { name: /Gerar o kit/ }));
    expect(await screen.findByText("Senha incorreta.")).toBeTruthy();
  });
});

describe("kitText", () => {
  it("funciona sem endereço, sem chaves e sem códigos extras", () => {
    const text = kitText({
      generatedAt: "2026-10-27T10:00:00Z",
      panelAddress: null,
      panelAddressIp: null,
      linuxUser: null,
      sshPort: null,
      keys: [],
      hostKeys: [],
      recoveryCodesLeft: 0,
      emailCodeEnabled: false,
      installDir: "/opt/tws-panel",
    } as never);
    expect(text).toContain("recuperar-acesso.sh");
    expect(text).not.toContain("https://");
  });
});

describe("EmailCodeSettings", () => {
  const renderCard = () =>
    render(
      <MemoryRouter>
        <EmailCodeSettings />
      </MemoryRouter>,
    );

  it("liga: pede o código por e-mail e envia os três fatores", async () => {
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Ligar o código por e-mail" }));
    fireEvent.click(await screen.findByRole("button", { name: "Enviar código" }));
    expect(await screen.findByText(/Código enviado para/)).toBeTruthy();
    fill("ecs");
    fireEvent.change(document.getElementById("ecs-email-code") as HTMLInputElement, { target: { value: "654321" } });
    const buttons = screen.getAllByRole("button", { name: "Ligar o código por e-mail" });
    fireEvent.click(buttons.at(-1)!);
    await waitFor(() => expect(calls.some((c) => c.path === "/api/auth/email-code/enable")).toBe(true));
    expect(calls.find((c) => c.path.endsWith("/enable"))!.body).toMatchObject({ emailCode: "654321", code: "123456" });
    expect(await screen.findByText(/Ligado\./)).toBeTruthy();
  });

  it("desliga com os três fatores", async () => {
    emailStatus = { ...emailStatus, enabled: true, enabledAt: "2026-10-27T10:00:00Z" };
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Desligar o código por e-mail" }));
    fill("ecs");
    fireEvent.change(document.getElementById("ecs-email-code") as HTMLInputElement, { target: { value: "654321" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Desligar o código por e-mail" }).at(-1)!);
    await waitFor(() => expect(calls.some((c) => c.path === "/api/auth/email-code/disable")).toBe(true));
  });

  it("mostra avisos: sem 2FA, sem endereço, e-mail não pronto, caixa na própria VPS", async () => {
    emailStatus = {
      ...emailStatus,
      twoFactorEnabled: false,
      address: null,
      mailReady: false,
      mailReason: "SMTP não configurado",
      canEnable: false,
    };
    renderCard();
    expect(await screen.findByText(/fator extra/)).toBeTruthy();
    expect(screen.getByText(/SMTP não configurado/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ligar o código por e-mail" })).toBeNull();
    cleanup();
    emailStatus = { ...emailStatus, twoFactorEnabled: true };
    renderCard();
    expect(await screen.findByText(/Cadastre o seu e-mail/)).toBeTruthy();
    cleanup();
    emailStatus = { ...emailStatus, address: "a***@meudominio.example.com", hostedHere: true, mailReady: true, canEnable: true };
    renderCard();
    expect(await screen.findByText(/hospedada nesta própria VPS/)).toBeTruthy();
  });

  it("mostra erro de leitura e de gravação", async () => {
    apiFetchMock.mockRejectedValueOnce(new ApiRequestError(500, "x", "Falhou."));
    renderCard();
    expect(await screen.findByText("Falhou.")).toBeTruthy();
    cleanup();
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Ligar o código por e-mail" }));
    fill("ecs");
    fireEvent.change(document.getElementById("ecs-email-code") as HTMLInputElement, { target: { value: "1" } });
    apiFetchMock.mockRejectedValueOnce(new ApiRequestError(400, "invalid_email_code", "Código do e-mail incorreto."));
    fireEvent.click(screen.getAllByRole("button", { name: "Ligar o código por e-mail" }).at(-1)!);
    expect(await screen.findByText("Código do e-mail incorreto.")).toBeTruthy();
  });
});
