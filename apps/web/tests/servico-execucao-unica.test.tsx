/**
 * Serviço de execução única (job de migração que reaproveita a imagem de outro serviço): terminou com 0 e
 * outros serviços esperam por ele. Na tela: "concluído (saiu com 0)", contado à parte e sem ponto vermelho.
 * Saiu com erro continua vermelho, com o código. Os alertas abertos do projeto aparecem com o detalhe.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposeServiceInfo, DockerContainerInfo } from "@paas/core";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { setLocale } from "@/i18n/core";
import { completedContainerIds, exitCodeOf } from "@/lib/one-shot";
import { ComposeServicesList } from "@/components/project/ComposeServices";
import { ProjectOverview } from "@/components/project/ProjectOverview";

const svc = (name: string, over: Partial<ComposeServiceInfo> = {}): ComposeServiceInfo => ({
  name,
  image: "app:1",
  build: null,
  publishedPorts: [],
  internalPorts: [],
  networkModeService: null,
  dependsOn: [],
  healthcheck: null,
  ...over,
});

const SERVICES: ComposeServiceInfo[] = [
  svc("app-migrate"),
  svc("app-web", { dependsOn: [{ service: "app-migrate", condition: "service_completed_successfully" }] }),
  svc("app-worker", { dependsOn: [{ service: "app-migrate", condition: "service_completed_successfully" }] }),
  svc("cache", { restart: "always" }),
];

const ct = (service: string, state: string, status: string, over: Partial<DockerContainerInfo> = {}): DockerContainerInfo => ({
  id: `id-${service}`,
  name: `paas-loja-${service}-1`,
  image: "x",
  state,
  status,
  managed: true,
  projectSlug: "loja",
  composeProject: "paas-loja",
  service,
  health: null,
  ports: [],
  ...over,
});

beforeEach(() => {
  setLocale("pt-BR");
  apiFetchMock.mockReset();
});
afterEach(cleanup);

describe("completedContainerIds", () => {
  it("saiu com 0 e é esperado por outro serviço: concluído (também pelo texto do status)", () => {
    const done = completedContainerIds(SERVICES, [ct("app-migrate", "exited", "Exited (0) 12 minutes ago")]);
    expect([...done]).toEqual(["id-app-migrate"]);
  });

  it("saiu com erro, ainda rodando ou sem lista de serviços: não é concluído", () => {
    expect(completedContainerIds(SERVICES, [ct("app-migrate", "exited", "Exited (1) 1 minute ago")]).size).toBe(0);
    expect(completedContainerIds(SERVICES, [ct("app-migrate", "running", "Up 1 minute")]).size).toBe(0);
    expect(completedContainerIds(undefined, [ct("app-migrate", "exited", "Exited (0) 1 minute ago")]).size).toBe(0);
    expect(completedContainerIds(SERVICES, [ct("fora-da-lista", "exited", "Exited (0) 1 minute ago")]).size).toBe(0);
  });

  it("sem ninguém esperando: política que não religa = concluído; always = serviço que caiu", () => {
    expect(completedContainerIds([svc("seed")], [ct("seed", "exited", "Exited (0) 1 minute ago")]).size).toBe(1);
    expect(completedContainerIds(SERVICES, [ct("cache", "exited", "Exited (0) 1 minute ago")]).size).toBe(0);
  });

  it("exitCodeOf prefere o código do servidor", () => {
    expect(exitCodeOf({ status: "Exited (1) agora", exitCode: 0 })).toBe(0);
    expect(exitCodeOf({ status: "Exited (3) agora" })).toBe(3);
    expect(exitCodeOf({ status: "Up" })).toBeNull();
  });
});

describe("Serviços do compose", () => {
  it("job concluído aparece como 'concluído (saiu com 0)', não como parado", () => {
    render(
      <ComposeServicesList
        services={SERVICES}
        entryService="app-web"
        entryPort={3000}
        containers={[ct("app-migrate", "exited", "Exited (0) 12 minutes ago"), ct("cache", "exited", "Exited (0) 1 minute ago")]}
      />,
    );
    expect(screen.getByTestId("compose-service-app-migrate")).toHaveTextContent("concluído (saiu com 0)");
    expect(screen.getByTestId("compose-service-app-migrate")).not.toHaveTextContent("parado");
    // serviço comum que saiu (mesmo com 0) continua parado
    expect(screen.getByTestId("compose-service-cache")).toHaveTextContent("parado");
  });

  it("job que saiu com erro mostra o código", () => {
    render(
      <ComposeServicesList services={SERVICES} entryService={null} entryPort={null} containers={[ct("app-migrate", "exited", "Exited (1) 1 minute ago")]} />,
    );
    expect(screen.getByTestId("compose-service-app-migrate")).toHaveTextContent("parado (saiu com 1)");
  });
});

function overview(containers: DockerContainerInfo[]) {
  const project = {
    id: "p1",
    name: "loja",
    slug: "loja",
    ingestMode: "git",
    source: "x",
    branch: "main",
    domain: "loja.example.com",
    websocket: false,
    detection: { type: "compose", services: SERVICES },
    proxyService: null,
    proxyPort: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    lastDeployAt: null,
    lastDeployStatus: null,
  } as never;
  return render(
    <MemoryRouter>
      <ProjectOverview project={project} status="running" containers={containers} jobs={[]} latestJob={null} onOpenJob={() => {}} />
    </MemoryRouter>,
  );
}

describe("Visão geral", () => {
  beforeEach(() => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path.includes("/https")) return { domains: [] };
      if (path.includes("/email")) return { email: null };
      if (path.startsWith("/api/alerts")) return { alerts: [], total: 0, openCount: 0, page: 1, perPage: 20 };
      return {};
    });
  });

  it("resumo conta o concluído à parte e o ponto dele não é vermelho", async () => {
    overview([
      ct("app-web", "running", "Up 5 minutes"),
      ct("cache", "running", "Up 5 minutes"),
      ct("app-migrate", "exited", "Exited (0) 12 minutes ago"),
    ]);
    const card = screen.getByTestId("overview-containers");
    expect(card).toHaveTextContent("2/2 rodando · 1 concluído(s)");
    const row = screen.getByText(/paas-loja-app-migrate-1/);
    expect(row).toHaveTextContent("concluído (saiu com 0)");
    expect(row.querySelector("span.rounded-full")!.className).not.toMatch(/red/);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/alerts?project=loja")));
  });

  it("job que saiu com erro continua vermelho e entra na conta de parados", () => {
    overview([ct("app-web", "running", "Up 5 minutes"), ct("app-migrate", "exited", "Exited (1) 1 minute ago")]);
    expect(screen.getByTestId("overview-containers")).toHaveTextContent("1/2 rodando");
    expect(screen.getByText(/paas-loja-app-migrate-1/).querySelector("span.rounded-full")!.className).toMatch(/red/);
  });

  it("alertas abertos do projeto aparecem com o detalhe e o atalho para Alertas", async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path.includes("/https")) return { domains: [] };
      if (path.includes("/email")) return { email: null };
      if (path.startsWith("/api/alerts")) {
        return {
          alerts: [
            {
              id: "a1",
              severity: "warning",
              source: "resources",
              title: "loja/app-web não passa na verificação de saúde",
              detail: "Verificação: healthcheck do serviço app-web. Última saída: connection refused.",
              projectSlug: "loja",
              status: "open",
              createdAt: "2026-10-31T10:00:00Z",
              acknowledgedAt: null,
              resolvedAt: null,
            },
          ],
          total: 1,
          openCount: 1,
          page: 1,
          perPage: 20,
        };
      }
      return {};
    });
    overview([ct("app-web", "running", "Up 5 minutes (unhealthy)", { health: "unhealthy" })]);
    const item = await screen.findByTestId("overview-alert-a1");
    expect(item).toHaveTextContent("não passa na verificação de saúde");
    fireEvent.click(item.querySelector("summary")!);
    expect(item).toHaveTextContent("connection refused");
    expect(screen.getByRole("link", { name: /Ver em Alertas/ })).toHaveAttribute("href", "/alerts?project=loja");
  });
});
