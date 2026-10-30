import { Fragment } from "react";
import { createBrowserRouter, Navigate, Outlet } from "react-router";
import { RouterProvider } from "react-router/dom";
import { Layout } from "@/components/Layout";
import { RequireAuth } from "@/components/RequireAuth";
import { UpdateBanner } from "@/components/UpdateBanner";
import { AlertsPage } from "@/pages/AlertsPage";
import { AuditPage } from "@/pages/AuditPage";
import { DashboardPage } from "@/pages/DashboardPage";
import { MailDomainPage } from "@/pages/MailDomainPage";
import { MailPage } from "@/pages/MailPage";
import { MailEnviosPage } from "@/pages/MailEnviosPage";
import { CertificatesPage } from "@/pages/CertificatesPage";
import { NewProjectPage } from "@/pages/NewProjectPage";
import { ProjectDetailPage } from "@/pages/ProjectDetailPage";
import { HardeningPage } from "@/pages/HardeningPage";
import { HealthPage } from "@/pages/HealthPage";
import { TerminalPage } from "@/pages/TerminalPage";
import { SecurityPage } from "@/pages/SecurityPage";
import { SettingsLayout } from "@/pages/settings/SettingsLayout";
import { ProfileSettings } from "@/pages/settings/ProfileSettings";
import { SecuritySettings } from "@/pages/settings/SecuritySettings";
import { AccessSettings } from "@/pages/settings/AccessSettings";
import { ApiAccessSettings } from "@/pages/settings/ApiAccessSettings";
import { AppearanceSettings } from "@/pages/settings/AppearanceSettings";
import { NotificationSettings } from "@/pages/settings/NotificationSettings";
import { IntegrationSettings } from "@/pages/settings/IntegrationSettings";
import { OnboardingSettings } from "@/pages/settings/OnboardingSettings";
import { PanelDomainSettings } from "@/pages/settings/PanelDomainSettings";
import { AppsDomainSettings } from "@/pages/settings/AppsDomainSettings";
import { DynamicDomainsSettings } from "@/pages/settings/DynamicDomainsSettings";
import { BackupSettings } from "@/pages/settings/BackupSettings";
import { TimezoneSettings } from "@/pages/settings/TimezoneSettings";
import { MetricsSettings } from "@/pages/settings/MetricsSettings";
import { SetupPage } from "@/pages/SetupPage";
import { LoginPage } from "@/pages/LoginPage";
import { useI18n } from "@/i18n";

const router = createBrowserRouter([
  {
    element: (
      <RequireAuth>
        <Layout>
          <Outlet />
        </Layout>
      </RequireAuth>
    ),
    children: [
      { path: "/", element: <DashboardPage /> },
      { path: "/projects/new", element: <NewProjectPage /> },
      { path: "/projects/:id", element: <ProjectDetailPage /> },
      { path: "/projects/:id/:section", element: <ProjectDetailPage /> },
      { path: "/mail", element: <MailPage /> },
      // Antes de /mail/:domain: rota fixa (e "envios" não é nome de domínio, que tem ponto).
      { path: "/mail/envios", element: <MailEnviosPage /> },
      { path: "/mail/:domain", element: <MailDomainPage /> },
      { path: "/certificates", element: <CertificatesPage /> },
      { path: "/security", element: <SecurityPage /> },
      { path: "/security/hardening", element: <HardeningPage /> },
      { path: "/terminal", element: <TerminalPage /> },
      { path: "/health", element: <HealthPage /> },
      { path: "/alerts", element: <AlertsPage /> },
      { path: "/audit", element: <AuditPage /> },
      {
        path: "/settings",
        element: <SettingsLayout />,
        children: [
          { index: true, element: <Navigate to="/settings/profile" replace /> },
          { path: "profile", element: <ProfileSettings /> },
          { path: "security", element: <SecuritySettings /> },
          { path: "access", element: <AccessSettings /> },
          { path: "panel-domain", element: <PanelDomainSettings /> },
          { path: "apps-domain", element: <AppsDomainSettings /> },
          { path: "dynamic-domains", element: <DynamicDomainsSettings /> },
          { path: "appearance", element: <AppearanceSettings /> },
          { path: "notifications", element: <NotificationSettings /> },
          { path: "backups", element: <BackupSettings /> },
          { path: "timezone", element: <TimezoneSettings /> },
          { path: "integrations", element: <IntegrationSettings /> },
          { path: "metrics", element: <MetricsSettings /> },
          { path: "api-access", element: <ApiAccessSettings /> },
          { path: "onboarding", element: <OnboardingSettings /> },
        ],
      },
    ],
  },
  // wizard de setup e login ficam fora do layout/guard do dashboard
  { path: "/setup", element: <SetupPage /> },
  { path: "/login", element: <LoginPage /> },
  {
    path: "*",
    element: (
      <RequireAuth>
        <DashboardPage />
      </RequireAuth>
    ),
  },
]);

export function App() {
  const { locale } = useI18n();
  // Trocar de idioma remonta a árvore: nada fica com texto do idioma anterior
  // (inclusive texto montado fora de hooks). O estado da rota é do `router`.
  return (
    <Fragment key={locale}>
      <RouterProvider router={router} />
      <UpdateBanner />
    </Fragment>
  );
}
