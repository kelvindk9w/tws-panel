/**
 * settings-sections.test.tsx — Configurações como área própria: menu das
 * seções (Perfil, Segurança, Aparência, Notificações), cada uma no seu
 * endereço; /settings abre o Perfil; o menu do usuário leva até lá.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { createMemoryRouter, Navigate, RouterProvider, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminUser, UserPreferences } from "@paas/core";

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
  clearSetupToken: vi.fn(),
}));

import { ApiRequestError } from "@/lib/api";
import { AuthContext } from "@/lib/auth";
import { UserMenu } from "@/components/UserMenu";
import { SettingsLayout } from "@/pages/settings/SettingsLayout";
import { ProfileSettings } from "@/pages/settings/ProfileSettings";
import { SecuritySettings } from "@/pages/settings/SecuritySettings";
import { AppearanceSettings } from "@/pages/settings/AppearanceSettings";
import { NotificationSettings } from "@/pages/settings/NotificationSettings";

function Where() {
  const l = useLocation();
  return <p data-testid="where">{l.pathname + l.hash}</p>;
}

function Harness({ at }: { at: string }) {
  const [user, setUser] = useState<AdminUser>({ username: "admin", createdAt: "x", displayName: null, email: null });
  const [preferences, setPreferences] = useState<UserPreferences>({ navLayout: "top" });
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: (
          <>
            <UserMenu />
            <Where />
          </>
        ),
      },
      {
        path: "/settings",
        element: (
          <>
            <SettingsLayout />
            <Where />
            <p data-testid="menu-name">{user.displayName || user.username}</p>
          </>
        ),
        children: [
          { index: true, element: <Navigate to="/settings/profile" replace /> },
          { path: "profile", element: <ProfileSettings /> },
          { path: "security", element: <SecuritySettings /> },
          { path: "appearance", element: <AppearanceSettings /> },
          { path: "notifications", element: <NotificationSettings /> },
          { path: "panel-domain", element: <p>domínio</p> },
        ],
      },
    ],
    { initialEntries: [at] },
  );
  return (
    <AuthContext.Provider value={{ user, setUser, preferences, setPreferences }}>
      <RouterProvider router={router} />
    </AuthContext.Provider>
  );
}

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (path: string) => {
    if (path === "/api/auth/2fa") return { enabled: false, recoveryCodesLeft: 0 };
    if (path === "/api/security/monitor/last") return { config: { intervalMs: 6 * 3_600_000 } };
    if (path === "/api/notifications") {
      return {
        telegram: { state: "none", botUsername: null, chatTitle: null, connectedAt: null, testedAt: null },
        email: { available: false, unavailableReason: "O servidor de e-mail do painel não foi iniciado.", from: null, recipients: [], testedAt: null },
        kinds: { security: true, deploy: true, certificate: true, blacklist: true, disk: true, panel: false },
        history: [],
      };
    }
    return {};
  });
});
afterEach(cleanup);

describe("Configurações — seções", () => {
  it("/settings abre o Perfil, com o menu das quatro seções", async () => {
    render(<Harness at="/settings" />);
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/settings/profile"));
    const nav = screen.getByTestId("settings-nav");
    for (const s of ["Perfil", "Segurança", "Aparência", "Notificações"]) expect(nav).toHaveTextContent(s);
  });

  it("Domínio do painel tem a sua seção e endereço (/settings/panel-domain)", async () => {
    render(<Harness at="/settings/profile" />);
    fireEvent.click(screen.getByRole("link", { name: /Domínio do painel/ }));
    expect(await screen.findByTestId("where")).toHaveTextContent("/settings/panel-domain");
  });

  it("cada seção tem o seu endereço", async () => {
    render(<Harness at="/settings/profile" />);
    fireEvent.click(screen.getByRole("link", { name: /Notificações/ }));
    expect(await screen.findByTestId("where")).toHaveTextContent("/settings/notifications");
    expect(await screen.findByLabelText(/A cada quantas horas/)).toHaveValue(6);
    expect(await screen.findByTestId("telegram-card")).toBeInTheDocument();
  });

  it("Segurança reúne a troca de senha e a verificação em duas etapas, na própria página", async () => {
    render(<Harness at="/settings/security" />);
    expect(screen.getByLabelText(/Senha atual/)).toBeInTheDocument();
    expect(await screen.findByTestId("two-factor-intro")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("o menu do usuário leva a Configurações e à Segurança", async () => {
    render(<Harness at="/" />);
    fireEvent.click(screen.getByRole("button", { name: /admin/ }));
    fireEvent.click(screen.getByRole("button", { name: /Verificação em duas etapas/ }));
    expect(await screen.findByTestId("where")).toHaveTextContent("/settings/security#two-factor");
  });
});

describe("Configurações → Perfil", () => {
  it("nome de exibição salvo aparece no menu na hora", async () => {
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/settings/profile") {
        const body = JSON.parse(String(init?.body)) as { displayName: string };
        return { user: { username: "admin", createdAt: "x", displayName: body.displayName, email: null } };
      }
      return {};
    });
    render(<Harness at="/settings/profile" />);
    fireEvent.change(screen.getByLabelText(/Nome de exibição/), { target: { value: "Kelvin" } });
    fireEvent.click(screen.getByRole("button", { name: /Salvar/ }));
    await waitFor(() => expect(screen.getByTestId("menu-name")).toHaveTextContent("Kelvin"));
    const body = JSON.parse(String(apiFetchMock.mock.calls.find((c) => c[0] === "/api/settings/profile")![1].body));
    expect(body).toEqual({ displayName: "Kelvin", email: "" }); // sem trocar o usuário, não manda senha
  });

  it("trocar o usuário de login pede a senha atual antes de liberar o Salvar", async () => {
    render(<Harness at="/settings/profile" />);
    fireEvent.change(screen.getByLabelText(/Usuário de login/), { target: { value: "kelvin" } });
    expect(screen.getByRole("button", { name: /Salvar/ })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Sua senha atual/), { target: { value: "MinhaSenha123" } });
    expect(screen.getByRole("button", { name: /Salvar/ })).toBeEnabled();
  });

  it("erro do servidor aparece e nada muda no menu", async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/api/settings/profile") throw new ApiRequestError(400, "invalid_email", "E-mail inválido.");
      return {};
    });
    render(<Harness at="/settings/profile" />);
    fireEvent.change(screen.getByLabelText(/E-mail/), { target: { value: "x@y" } });
    fireEvent.click(screen.getByRole("button", { name: /Salvar/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("E-mail inválido.");
  });
});
