/**
 * Fumaça de i18n: as páginas principais renderizam em pt-BR e em en, nos
 * estados "carregando" e "erro de rede", sem chave crua (`ns.chave`) na tela e
 * sem aviso de chave ausente. Não cobre todos os estados de cada tela (isso é
 * dos testes de cada componente, em pt-BR); cobre a ligação com os dicionários.
 */
import { cleanup, render, waitFor } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserPreferences } from "@paas/core";
import { AuthContext } from "../src/lib/auth";
import { setLocale } from "../src/i18n";
import { NAMESPACES } from "../src/i18n/keys";
import { Layout } from "../src/components/Layout";
import { AlertsPage } from "../src/pages/AlertsPage";
import { AuditPage } from "../src/pages/AuditPage";
import { CertificatesPage } from "../src/pages/CertificatesPage";
import { DashboardPage } from "../src/pages/DashboardPage";
import { LoginPage } from "../src/pages/LoginPage";
import { MailEnviosPage } from "../src/pages/MailEnviosPage";
import { MailPage } from "../src/pages/MailPage";
import { NewProjectPage } from "../src/pages/NewProjectPage";
import { SecurityPage } from "../src/pages/SecurityPage";
import { SetupPage } from "../src/pages/SetupPage";
import { AppearanceSettings } from "../src/pages/settings/AppearanceSettings";
import { BackupSettings } from "../src/pages/settings/BackupSettings";
import { NotificationSettings } from "../src/pages/settings/NotificationSettings";
import { PanelDomainSettings } from "../src/pages/settings/PanelDomainSettings";
import { ProfileSettings } from "../src/pages/settings/ProfileSettings";
import { SecuritySettings } from "../src/pages/settings/SecuritySettings";
import { SettingsLayout } from "../src/pages/settings/SettingsLayout";
import { TimezoneSettings } from "../src/pages/settings/TimezoneSettings";
import { OnboardingChecklist } from "../src/components/onboarding/OnboardingChecklist";

const preferences: UserPreferences = { navLayout: "top" };
const auth = {
  user: { username: "admin", createdAt: "2026-01-01T00:00:00Z", displayName: null, email: null },
  setUser: () => {},
  preferences,
  setPreferences: () => {},
};

/** Registra a quebra da tela (em vez de escondê-la): o teste decide se era esperada. */
const crashes: string[] = [];
class Boundary extends Component<{ children: ReactNode }, { crashed: boolean }> {
  state = { crashed: false };
  static getDerivedStateFromError() {
    return { crashed: true };
  }
  componentDidCatch(error: Error) {
    crashes.push(error.message);
  }
  render() {
    return this.state.crashed ? null : this.props.children;
  }
}

const PAGES: Array<[string, () => ReactNode]> = [
  ["Login", () => <LoginPage />],
  ["Setup", () => <SetupPage />],
  ["Dashboard", () => <DashboardPage />],
  ["NewProject", () => <NewProjectPage />],
  ["Mail", () => <MailPage />],
  ["MailEnvios", () => <MailEnviosPage />],
  ["Certificates", () => <CertificatesPage />],
  ["Security", () => <SecurityPage />],
  ["Alerts", () => <AlertsPage />],
  ["Audit", () => <AuditPage />],
  ["Layout", () => <Layout>conteúdo</Layout>],
  ["SettingsLayout", () => <SettingsLayout />],
  ["Profile", () => <ProfileSettings />],
  ["SecuritySettings", () => <SecuritySettings />],
  ["Appearance", () => <AppearanceSettings />],
  ["Notifications", () => <NotificationSettings />],
  ["PanelDomain", () => <PanelDomainSettings />],
  ["Backups", () => <BackupSettings />],
  ["Timezone", () => <TimezoneSettings />],
  ["Onboarding", () => <OnboardingChecklist />],
];

/**
 * Páginas que quebram quando a API responde 200 com `{}` (corpo sem os campos
 * que o contrato garante: `projects`, `checks`...). Não é problema de idioma
 * nem acontece com o servidor real; acontecia antes da i18n e não é consertado
 * aqui. Qualquer outra quebra, em qualquer estado, reprova o teste.
 */
const EMPTY_BODY_CRASHES = new Set<string>(["Alerts", "Audit", "Backups", "Certificates", "Dashboard", "Mail", "Notifications", "PanelDomain", "Security", "Timezone"]);

const RAW_KEY = new RegExp(`\\b(?:${NAMESPACES.join("|")})\\.[A-Za-z0-9_]+(?:\\.[A-Za-z0-9_]+)*\\b`);

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  crashes.length = 0;
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each(["pt-BR", "en"])("páginas em %s", (locale) => {
  describe.each([
    ["rede fora do ar", () => Promise.reject(new TypeError("offline"))],
    ["resposta vazia", () => Promise.resolve(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }))],
    ["erro 500", () => Promise.resolve(new Response(JSON.stringify({ error: "internal_error", message: "x" }), { status: 500, headers: { "Content-Type": "application/json" } }))],
  ])("%s", (name, respond) => {
    it.each(PAGES)("%s sem chave crua nem aviso de chave ausente", async (page, element) => {
      setLocale(locale, { persist: false });
      vi.stubGlobal("fetch", vi.fn(respond));
      const { container } = render(
        <AuthContext.Provider value={auth}>
          <MemoryRouter>
            <Boundary>{element()}</Boundary>
          </MemoryRouter>
        </AuthContext.Provider>,
      );
      // deixa as chamadas falharem/terminarem e a tela mostrar o estado de erro
      await waitFor(() => expect(container.ownerDocument.body.textContent).not.toBeNull());
      await new Promise((r) => setTimeout(r, 30));
      // texto de cada nó separado: "setup" + ".Usuário" em elementos vizinhos não é chave
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const texts: string[] = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n.textContent ?? "");
      const labels = [...container.querySelectorAll("[aria-label],[title],[placeholder]")].flatMap((el) => [
        el.getAttribute("aria-label"),
        el.getAttribute("title"),
        el.getAttribute("placeholder"),
      ]);
      expect(texts.filter((x) => RAW_KEY.test(x))).toEqual([]);
      expect(labels.filter((l) => l && RAW_KEY.test(l))).toEqual([]);
      if (!(name === "resposta vazia" && EMPTY_BODY_CRASHES.has(page))) {
        expect(crashes, "a tela quebrou ao renderizar").toEqual([]);
      }
      const missing = warn.mock.calls.filter((c) => String(c[0]).startsWith("[i18n]"));
      expect(missing).toEqual([]);
    });
  });
});
