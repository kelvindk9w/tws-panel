import { createBrowserRouter, Outlet } from "react-router";
import { RouterProvider } from "react-router/dom";
import { Layout } from "@/components/Layout";
import { RequireAuth } from "@/components/RequireAuth";
import { AlertsPage } from "@/pages/AlertsPage";
import { AuditPage } from "@/pages/AuditPage";
import { DashboardPage } from "@/pages/DashboardPage";
import { MailDomainPage } from "@/pages/MailDomainPage";
import { MailPage } from "@/pages/MailPage";
import { NewProjectPage } from "@/pages/NewProjectPage";
import { ProjectDetailPage } from "@/pages/ProjectDetailPage";
import { HardeningPage } from "@/pages/HardeningPage";
import { SecurityPage } from "@/pages/SecurityPage";
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
      { path: "/mail", element: <MailPage /> },
      { path: "/mail/:domain", element: <MailDomainPage /> },
      { path: "/security", element: <SecurityPage /> },
      { path: "/security/hardening", element: <HardeningPage /> },
      { path: "/alerts", element: <AlertsPage /> },
      { path: "/audit", element: <AuditPage /> },
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
  return <RouterProvider router={router} />;
}
