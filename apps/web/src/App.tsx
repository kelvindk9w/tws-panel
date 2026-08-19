import { createBrowserRouter, Outlet, RouterProvider } from "react-router-dom";
import { Layout } from "@/components/Layout";
import { AlertsPage } from "@/pages/AlertsPage";
import { AuditPage } from "@/pages/AuditPage";
import { DashboardPage } from "@/pages/DashboardPage";
import { MailDomainPage } from "@/pages/MailDomainPage";
import { MailPage } from "@/pages/MailPage";
import { NewProjectPage } from "@/pages/NewProjectPage";
import { ProjectDetailPage } from "@/pages/ProjectDetailPage";
import { SecurityPage } from "@/pages/SecurityPage";
import { SetupPage } from "@/pages/SetupPage";

const router = createBrowserRouter([
  {
    element: (
      <Layout>
        <Outlet />
      </Layout>
    ),
    children: [
      { path: "/", element: <DashboardPage /> },
      { path: "/projects/new", element: <NewProjectPage /> },
      { path: "/projects/:id", element: <ProjectDetailPage /> },
      { path: "/mail", element: <MailPage /> },
      { path: "/mail/:domain", element: <MailDomainPage /> },
      { path: "/security", element: <SecurityPage /> },
      { path: "/alerts", element: <AlertsPage /> },
      { path: "/audit", element: <AuditPage /> },
    ],
  },
  // wizard de setup continua intacto, fora do layout do dashboard
  { path: "/setup", element: <SetupPage /> },
  { path: "*", element: <DashboardPage /> },
]);

export function App() {
  return <RouterProvider router={router} />;
}
