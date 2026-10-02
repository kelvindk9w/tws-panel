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
import { CertificatesPage } from "@/pages/CertificatesPage";
import { NewProjectPage } from "@/pages/NewProjectPage";
import { ProjectDetailPage } from "@/pages/ProjectDetailPage";
import { HardeningPage } from "@/pages/HardeningPage";
import { HealthPage } from "@/pages/HealthPage";
import { SecurityPage } from "@/pages/SecurityPage";
import { SettingsLayout } from "@/pages/settings/SettingsLayout";
import { ProfileSettings } from "@/pages/settings/ProfileSettings";
import { SecuritySettings } from "@/pages/settings/SecuritySettings";
import { AppearanceSettings } from "@/pages/settings/AppearanceSettings";
import { NotificationSettings } from "@/pages/settings/NotificationSettings";
import { IntegrationSettings } from "@/pages/settings/IntegrationSettings";
import { OnboardingSettings } from "@/pages/settings/OnboardingSettings";
import { SetupPage } from "@/pages/SetupPage";
import { LoginPage } from "@/pages/LoginPage";

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
      { path: "/mail/:domain", element: <MailDomainPage /> },
      { path: "/certificates", element: <CertificatesPage /> },
      { path: "/security", element: <SecurityPage /> },
      { path: "/security/hardening", element: <HardeningPage /> },
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
          { path: "appearance", element: <AppearanceSettings /> },
          { path: "notifications", element: <NotificationSettings /> },
          { path: "integrations", element: <IntegrationSettings /> },
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
  return (
    <>
      <RouterProvider router={router} />
      <UpdateBanner />
    </>
  );
}
