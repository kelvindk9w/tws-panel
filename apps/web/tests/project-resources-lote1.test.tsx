/**
 * project-resources-lote1.test.tsx — aba Recursos: réplicas rodando × desejadas, memória perto do limite,
 * limite de CPU e throttling, tempo de subida e marcas de deploy nos gráficos; mais o histórico de deploys
 * (duração por etapa e tempo de subida).
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeployJob, MetricPoint, ProjectMetricsResponse, ProjectServiceMetrics } from "@paas/core";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { setLocale } from "@/i18n/core";
import { ProjectResourcesSection } from "@/components/project/ProjectResourcesSection";
import { DeployHistory } from "@/components/project/DeployHistory";
import { DeploySteps } from "@/components/project/DeployLog";
import { deployDuration, formatSeconds, startupSummary, stepDuration } from "@/components/project/deploy-format";

const T = Date.parse("2026-10-24T12:00:00Z") / 1000;
const line = (vals: number[]): MetricPoint[] => vals.map((v, i) => ({ t: T - 3600 + i * 600, v, max: v })).map((p) => p);

const svc = (name: string, latest: ProjectServiceMetrics["latest"], series: ProjectServiceMetrics["series"] = {}): ProjectServiceMetrics => ({
  service: name,
  latest,
  series: { cpu: line([10, 20]), mem: line([1e8, 2e8]), ...series },
});

function reply(over: Partial<ProjectMetricsResponse> = {}): ProjectMetricsResponse {
  return {
    range: "24h",
    resolution: "minute",
    stepSeconds: 240,
    from: T - 86400,
    to: T,
    partial: false,
    total: { service: "", series: { cpu: line([15, 25]), mem: line([3e8, 4e8]) }, latest: { cpu: 25, mem: 4e8 } },
    services: [],
    events: [],
    collector: { mode: "full", hostSource: "mounted", containerSource: "cgroup", lastTickAt: null, lastError: null, retention: { minuteHours: 48, hourDays: 90, dayDays: 730 } },
    ...over,
  };
}

function show() {
  return render(
    <MemoryRouter>
      <ProjectResourcesSection projectId="p1" />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  setLocale("pt-BR");
  apiFetchMock.mockReset();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});
afterEach(() => cleanup());

describe("serviços: réplicas, memória e CPU limitada", () => {
  it("mostra 'rodando × desejadas' só quando importa (várias réplicas ou alguma faltando)", async () => {
    apiFetchMock.mockResolvedValue(
      reply({
        services: [
          svc("web", { up: 1, replicas: 2, replicasWanted: 3 }),
          svc("api", { up: 1, replicas: 3, replicasWanted: 3 }),
          svc("db", { up: 1, replicas: 1, replicasWanted: 1 }),
          svc("job", { up: 0, replicas: 0, replicasWanted: 1 }),
        ],
      }),
    );
    show();
    expect(await screen.findByTestId("replicas-web")).toHaveTextContent("2 de 3 rodando");
    expect(screen.getByTestId("replicas-api")).toHaveTextContent("3 de 3 rodando");
    expect(screen.queryByTestId("replicas-db")).toBeNull();
    expect(screen.getByTestId("replicas-job")).toHaveTextContent("0 de 1 rodando");
  });

  it("memória perto do limite (≥ 90%) é destacada; abaixo disso só mostra o percentual; sem limite não mostra", async () => {
    apiFetchMock.mockResolvedValue(
      reply({
        services: [svc("web", { up: 1, mem: 950, memLimit: 1000 }), svc("api", { up: 1, mem: 400, memLimit: 1000 }), svc("db", { up: 1, mem: 400 })],
      }),
    );
    show();
    expect(await screen.findByTestId("mem-pct-web")).toHaveTextContent("95% do limite · perto do limite de memória");
    expect(screen.getByTestId("mem-pct-api")).toHaveTextContent(/^40% do limite$/);
    expect(screen.queryByTestId("mem-pct-db")).toBeNull();
  });

  it("limite de CPU: mostra o limite e se foi segurado; gráfico de throttling só aparece quando há medida", async () => {
    apiFetchMock.mockResolvedValue(
      reply({
        total: { service: "", series: { cpu: line([15]), mem: line([3e8]), cpuThrottle: line([5, 30]) }, latest: { cpu: 25 } },
        services: [svc("web", { up: 1, cpuLimit: 50 }, { cpuThrottle: line([5, 30]) }), svc("api", { up: 1, cpuLimit: 100 }, {}), svc("db", { up: 1 })],
      }),
    );
    show();
    expect(await screen.findByTestId("cpu-limit-web")).toHaveTextContent("Limite: 50% de um núcleo · Segurado pelo limite em 30% do tempo (pico 30%)");
    expect(screen.getByTestId("cpu-limit-api")).toHaveTextContent("Sem ser segurado pelo limite");
    expect(screen.queryByTestId("cpu-limit-db")).toBeNull();
    expect(screen.getByTestId("resources-throttle")).toBeInTheDocument();
  });

  it("sem throttling medido, nada do gráfico", async () => {
    apiFetchMock.mockResolvedValue(reply({ services: [svc("web", { up: 1 })] }));
    show();
    await screen.findByTestId("tile-cpu");
    expect(screen.queryByTestId("resources-throttle")).toBeNull();
  });
});

describe("tempo de subida e marcas de deploy", () => {
  it("lista as subidas (exata, aproximada, por saúde ou por porta) e desenha uma marca por deploy da janela", async () => {
    apiFetchMock.mockResolvedValue(
      reply({
        deploys: [
          { id: "d1", t: T - 7200, end: T - 7100, kind: "deploy", status: "success" },
          { id: "d2", t: T - 3000, end: T - 2900, kind: "recreate", status: "failed" },
          { id: "d3", t: T - 100, end: null, kind: "deploy", status: "queued" },
          { id: "fora", t: T - 999_999, end: T - 999_000, kind: "deploy", status: "success" },
        ],
        startups: [
          { slug: "loja", service: "web", startedAt: "2026-10-24T11:00:00Z", readyAt: "2026-10-24T11:00:12Z", seconds: 12, via: "health", approx: false },
          { slug: "loja", service: "api", startedAt: "2026-10-24T10:00:00Z", readyAt: "2026-10-24T10:01:10Z", seconds: 70, via: "port", approx: true },
        ],
      }),
    );
    show();
    const list = await screen.findByTestId("resources-startups");
    const items = within(list).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("web: 12s");
    expect(items[0]).toHaveTextContent("até ficar saudável");
    expect(items[0]).not.toHaveTextContent("aproximado");
    expect(items[1]).toHaveTextContent("api: ~1min 10s");
    expect(items[1]).toHaveTextContent("até abrir a porta · aproximado");
    // só os gráficos com medida desenham (processador e memória) × 3 deploys na janela; o de fora da janela não
    const marks = screen.getAllByTestId("chart-mark");
    expect(marks.length).toBe(2 * 3);
    expect(screen.getAllByTestId("chart-marks-legend")[0]).toHaveTextContent(/Linhas tracejadas, deploys do período: Deploy .*\(sucesso\)/);
    expect(screen.getAllByTestId("chart-marks-legend")[0]).toHaveTextContent("Reinício com a configuração nova");
  });

  it("sem subida medida, explica; sem deploys, sem marcas", async () => {
    apiFetchMock.mockResolvedValue(reply({ startups: [], deploys: [] }));
    show();
    expect(await screen.findByTestId("resources-no-startups")).toBeInTheDocument();
    expect(screen.queryAllByTestId("chart-mark")).toHaveLength(0);
    expect(screen.queryByTestId("chart-marks-legend")).toBeNull();
  });

  it("resposta antiga (sem deploys nem startups) continua abrindo", async () => {
    apiFetchMock.mockResolvedValue(reply());
    show();
    expect(await screen.findByTestId("resources-no-startups")).toBeInTheDocument();
  });
});

describe("histórico de deploys: duração por etapa e tempo de subida", () => {
  const job = (over: Partial<DeployJob> = {}): DeployJob => ({
    id: "abcdef123456",
    projectId: "p1",
    status: "success",
    createdAt: "2026-10-27T10:00:00.000Z",
    startedAt: "2026-10-27T10:00:00.000Z",
    finishedAt: "2026-10-27T10:03:00.000Z",
    steps: [
      { name: "Ingestão do código", status: "done", startedAt: "2026-10-27T10:00:00.000Z", finishedAt: "2026-10-27T10:00:20.000Z" },
      { name: "Build e subida", status: "done", startedAt: "2026-10-27T10:00:20.000Z", finishedAt: "2026-10-27T10:02:50.000Z" },
      { name: "Health check", status: "skipped" },
      { name: "Proxy", status: "done" },
    ],
    log: "",
    error: null,
    ...over,
  });

  it("etapas mostram quanto levaram (deploys antigos, sem horário, ficam como eram)", () => {
    render(<DeploySteps job={job()} />);
    expect(screen.getByText("(20s)")).toBeInTheDocument();
    expect(screen.getByText("(2min 30s)")).toBeInTheDocument();
    expect(screen.queryAllByText(/^\(/)).toHaveLength(2);
  });

  it("linha do histórico mostra o tempo de subida de cada serviço, com til nas medidas aproximadas", () => {
    render(
      <DeployHistory
        jobs={[
          job({ startups: [{ service: "web", seconds: 12, via: "health", approx: false }, { service: "api", seconds: 70, via: "port", approx: true }] }),
          job({ id: "outro-deploy-1", startups: [] }),
        ]}
        onOpen={() => undefined}
      />,
    );
    expect(screen.getByTestId("job-startup-abcdef123456")).toHaveTextContent("subida: web 12s, api ~1min 10s");
    expect(screen.queryByTestId("job-startup-outro-deploy-1")).toBeNull();
  });

  it("funções de formato", () => {
    expect(formatSeconds(45.4)).toBe("45s");
    expect(formatSeconds(-3)).toBe("0s");
    expect(formatSeconds(125)).toBe("2min 5s");
    expect(startupSummary(undefined)).toBe("");
    expect(stepDuration({ name: "x", status: "skipped" })).toBeNull();
    expect(stepDuration({ name: "x", status: "done", startedAt: "2026-10-27T10:00:00Z" })).toBeNull();
    expect(stepDuration({ name: "x", status: "running", startedAt: "2026-10-27T10:00:00Z" }, Date.parse("2026-10-27T10:00:09Z"))).toBe("9s");
    expect(deployDuration(job())).toBe("3min 0s");
  });
});
