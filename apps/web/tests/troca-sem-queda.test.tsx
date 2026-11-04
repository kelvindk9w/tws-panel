/**
 * Troca sem queda na interface: ajuste por projeto (só para projetos de um container) e as fases no detalhe do deploy.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeployJob, Project } from "@paas/core";
import { ProjectConfigCard } from "../src/components/ProjectConfigCard";
import { DeploySteps } from "../src/components/project/DeployLog";

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));
vi.mock("@/lib/api", async () => {
  const real = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return { ...real, apiFetch: apiFetchMock };
});

function projeto(type: string | null, over: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "Loja",
    slug: "loja",
    ingestMode: "git",
    source: "https://example.com/usuario/app.git",
    branch: "main",
    domain: "loja.exemplo.com",
    websocket: false,
    detection: type ? ({ type, warnings: [], details: [] } as never) : null,
    proxyService: null,
    proxyPort: null,
    createdAt: "",
    updatedAt: "",
    lastDeployAt: null,
    lastDeployStatus: null,
    deployedBranch: null,
    deployedSource: null,
    ...over,
  };
}

afterEach(() => {
  cleanup();
  apiFetchMock.mockReset();
});

const caixa = () => screen.getByRole("checkbox", { name: /troca sem queda/i });

describe("ajuste Troca sem queda", () => {
  it("Next.js e estático: vem ligado; desligar e salvar envia só isso", async () => {
    apiFetchMock.mockResolvedValue({ project: projeto("node-server") });
    render(<ProjectConfigCard section="general" project={projeto("node-server")} onSaved={vi.fn()} />);
    expect(caixa()).toBeChecked();
    await userEvent.click(caixa());
    await userEvent.click(screen.getByRole("button", { name: /^salvar$/i }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(JSON.parse(apiFetchMock.mock.calls[0][1].body)).toEqual({ zeroDowntime: false });
    expect(screen.queryByText(/vem desligada/i)).toBeNull();
  });

  it("Dockerfile: vem desligado, com a explicação; ligar envia true", async () => {
    apiFetchMock.mockResolvedValue({ project: projeto("dockerfile") });
    render(<ProjectConfigCard section="general" project={projeto("dockerfile")} onSaved={vi.fn()} />);
    expect(caixa()).not.toBeChecked();
    expect(screen.getByText(/vem desligada/i)).toBeInTheDocument();
    await userEvent.click(caixa());
    await userEvent.click(screen.getByRole("button", { name: /^salvar$/i }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(JSON.parse(apiFetchMock.mock.calls[0][1].body)).toEqual({ zeroDowntime: true });
  });

  it("escolha já gravada vale (Next.js desligado); compose e projeto sem tipo não mostram o ajuste", () => {
    render(<ProjectConfigCard section="general" project={projeto("node-server", { zeroDowntime: false })} onSaved={vi.fn()} />);
    expect(caixa()).not.toBeChecked();
    cleanup();
    render(<ProjectConfigCard section="general" project={projeto("compose")} onSaved={vi.fn()} />);
    expect(screen.queryByTestId("config-zero-downtime")).toBeNull();
    cleanup();
    render(<ProjectConfigCard section="general" project={projeto(null)} onSaved={vi.fn()} />);
    expect(screen.queryByTestId("config-zero-downtime")).toBeNull();
  });

  it("a seção Git não mostra o ajuste", () => {
    render(<ProjectConfigCard section="git" project={projeto("node-server")} onSaved={vi.fn()} />);
    expect(screen.queryByTestId("config-zero-downtime")).toBeNull();
  });
});

describe("fases da troca no detalhe do deploy", () => {
  const job = (over: Partial<DeployJob> = {}): DeployJob => ({
    id: "j1",
    projectId: "p1",
    status: "running",
    createdAt: "2026-11-02T10:00:00.000Z",
    startedAt: "2026-11-02T10:00:00.000Z",
    finishedAt: null,
    steps: [{ name: "Build e subida", status: "running" }],
    log: "",
    error: null,
    ...over,
  });

  it("mostra as quatro fases com o estado de cada uma", () => {
    render(
      <DeploySteps
        job={job({
          phases: [
            { name: "Subindo nova versão", status: "done", startedAt: "2026-11-02T10:00:00.000Z", finishedAt: "2026-11-02T10:00:09.000Z" },
            { name: "Verificando saúde", status: "running" },
            { name: "Trocando tráfego", status: "skipped" },
            { name: "Desligando versão anterior", status: "skipped" },
          ],
        })}
      />,
    );
    const bloco = screen.getByTestId("deploy-phases");
    expect(bloco).toHaveTextContent("Troca sem queda");
    for (const nome of ["Subindo nova versão", "Verificando saúde", "Trocando tráfego", "Desligando versão anterior"]) expect(bloco).toHaveTextContent(nome);
    expect(screen.getByTestId("phase-running")).toHaveTextContent("Verificando saúde");
    expect(screen.getAllByTestId("phase-skipped")).toHaveLength(2);
    expect(bloco).toHaveTextContent("(9s)");
  });

  it("deploy sem troca não mostra a linha de fases (nem vazia)", () => {
    render(<DeploySteps job={job()} />);
    expect(screen.queryByTestId("deploy-phases")).toBeNull();
    cleanup();
    render(<DeploySteps job={job({ phases: [] })} />);
    expect(screen.queryByTestId("deploy-phases")).toBeNull();
  });
});
