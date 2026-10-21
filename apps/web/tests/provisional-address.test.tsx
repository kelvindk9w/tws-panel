/**
 * provisional-address.test.tsx — projeto com o endereço provisório (nome-xxxxx.localhost)
 * num painel público: o link não abre no computador da pessoa, então a Visão geral e a
 * lista de projetos avisam em âmbar e levam a Domínios. Em painel local nada muda.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { setLocale } from "@/i18n/core";
import { resetPanelPublicCache } from "@/components/project/ProvisionalAddressNotice";
import { ProjectOverview } from "@/components/project/ProjectOverview";
import { DashboardPage } from "@/pages/DashboardPage";

const PROV = "loja-p4r7m.localhost";
const project = (domain: string) =>
  ({ id: "p1", name: "loja", slug: "loja", ingestMode: "git", source: "x", branch: "main", domain, websocket: false, detection: null, proxyService: null, proxyPort: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", lastDeployAt: null, lastDeployStatus: null }) as never;

let panelPublic = true;
function panelHost(hostname: string) {
  // quem decide é o servidor (panelPublic), não o nome com que a página foi aberta
  panelPublic = hostname !== "localhost";
}

beforeEach(() => {
  setLocale("pt-BR");
  resetPanelPublicCache();
  panelPublic = true;
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/domains/suggest")) return { auto: "x", publicIp: null, panelPublic };
    if (path === "/api/projects") return { projects: [{ project: project(PROV), status: "created", containers: [] }] };
    if (path.includes("/https")) return { domains: [] };
    if (path.includes("/email")) return { email: null };
    return { containers: [] };
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function overview(domain: string) {
  return render(
    <MemoryRouter>
      <ProjectOverview project={project(domain)} status="created" containers={[]} jobs={[]} latestJob={null} onOpenJob={() => {}} />
    </MemoryRouter>,
  );
}

describe("Visão geral com endereço provisório", () => {
  it("painel público: aviso âmbar com atalho para Domínios e sem link para o .localhost", async () => {
    panelHost("painel.example.com");
    overview(PROV);
    const aviso = await screen.findByTestId("provisional-notice");
    expect(aviso).toHaveAttribute("role", "note");
    expect(aviso.className).toMatch(/amber/);
    expect(aviso).toHaveTextContent("Endereço provisório: escolha o endereço em Domínios");
    expect(within(aviso).getByRole("link", { name: /Escolher o endereço/ })).toHaveAttribute("href", "/projects/p1/domains");
    expect(screen.queryByRole("link", { name: new RegExp(PROV) })).not.toBeInTheDocument();
    expect(screen.getByTestId("overview-domains")).toHaveTextContent(PROV);
  });

  it("painel local: sem aviso e o link continua", async () => {
    panelHost("localhost");
    overview(PROV);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/domains/suggest")));
    expect(screen.getByRole("link", { name: new RegExp(PROV) })).toBeInTheDocument();
    expect(screen.queryByTestId("provisional-notice")).not.toBeInTheDocument();
  });

  it("endereço definitivo num painel público: sem aviso e com link", async () => {
    panelHost("painel.example.com");
    overview("loja-k3x9q.apps.example.com");
    expect(screen.getByRole("link", { name: /loja-k3x9q\.apps\.example\.com/ })).toBeInTheDocument();
    expect(screen.queryByTestId("provisional-notice")).not.toBeInTheDocument();
  });
});

describe("painel aberto por túnel SSH (localhost no navegador) mas público no servidor", () => {
  it("o aviso aparece mesmo com o navegador em localhost", async () => {
    vi.stubGlobal("location", { ...window.location, hostname: "localhost" });
    panelPublic = true;
    overview(PROV);
    expect(await screen.findByTestId("provisional-notice")).toBeInTheDocument();
  });
});

describe("lista de projetos com endereço provisório", () => {
  it("painel público: o cartão avisa e não linka o .localhost", async () => {
    panelHost("painel.example.com");
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );
    const aviso = await screen.findByTestId("provisional-notice");
    expect(aviso).toHaveTextContent("Endereço provisório");
    expect(within(aviso).getByRole("link", { name: /Escolher o endereço/ })).toHaveAttribute("href", "/projects/p1/domains");
    expect(screen.queryByRole("link", { name: new RegExp(PROV) })).not.toBeInTheDocument();
  });
});
