/**
 * "Não procede — não avisar mais" na tela: a ação em cada achado (menos nas regras inegociáveis), o diálogo com
 * abrangência, motivo e (para bloqueio) reautenticação, a seção recolhida "Alertas dispensados (N)" com "Voltar
 * a avisar" e, no diálogo de bloqueio do deploy, o relatório atualizado depois de dispensar.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuardrailDismissal, GuardrailReport, ProjectResponse } from "@paas/core";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { ApiRequestError } from "@/lib/api";
import { DismissedGuardrailsSection, GuardrailDismissDialog, ProjectGuardrailNotices } from "@/components/project/GuardrailDismiss";
import { GuardrailOverrideModal, ProjectDetailPage } from "@/pages/ProjectDetailPage";
import { NewProjectPage } from "@/pages/NewProjectPage";

const SERVICES = ["web", "api", "worker", "cron"];
const WARNINGS = [
  ...SERVICES.map((s) => ({
    id: "compose.weak-credentials",
    severity: "warning" as const,
    service: s,
    rule: "weak-credentials",
    target: "CACHE_SALT",
    message: `Serviço "${s}" define CACHE_SALT com valor fraco ou previsível.`,
  })),
  { id: "compose.privileged-container", severity: "critical" as const, service: "web", rule: "privileged-container", evidence: 'compose.yml: serviço "web" define privileged: true', message: "Container privilegiado — isso vai BLOQUEAR o deploy." },
  { id: "compose.no-services", severity: "info" as const, message: "Aviso sem regra." },
];

const PROJECT = {
  id: "p1",
  name: "loja",
  slug: "loja",
  ingestMode: "git",
  source: "https://example.com/loja.git",
  branch: "main",
  domain: "loja.example.com",
  websocket: false,
  detection: { type: "compose", composeFile: "compose.yml", outputDir: null, packageManager: null, buildCommand: null, proxyService: "web", proxyPort: 80, warnings: WARNINGS, details: [] },
  proxyService: null,
  proxyPort: null,
  createdAt: "2026-11-01T10:00:00Z",
  updatedAt: "2026-11-01T10:00:00Z",
  lastDeployAt: null,
  lastDeployStatus: null,
  deployedBranch: null,
  deployedSource: null,
} as unknown as ProjectResponse["project"];

const DISMISSED: GuardrailDismissal = {
  id: "d1",
  rule: "weak-credentials",
  service: null,
  match: "target",
  value: "CACHE_SALT",
  title: "Credencial fraca",
  reason: "não é senha",
  by: "admin",
  at: "2026-11-06T12:00:00.000Z",
};

let dismissals: GuardrailDismissal[];

beforeEach(() => {
  dismissals = [];
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/projects/p1/guardrails/dismissals" && init?.method === "POST") {
      dismissals = [DISMISSED];
      return { dismissal: DISMISSED };
    }
    if (path === "/api/projects/p1/guardrails/dismissals/d1" && init?.method === "DELETE") {
      dismissals = [];
      return undefined;
    }
    if (path === "/api/projects/p1/guardrails/dismissals") return { dismissals };
    return {};
  });
});
afterEach(cleanup);

const posts = () => apiFetchMock.mock.calls.filter(([p, i]) => p === "/api/projects/p1/guardrails/dismissals" && (i as RequestInit)?.method === "POST");

describe("avisos da Visão geral", () => {
  it("cada achado dispensável tem a ação; o inegociável e o aviso sem regra não", async () => {
    render(<ProjectGuardrailNotices project={PROJECT} />);
    expect(await screen.findByText(/Guardrails \(6\)/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Não procede/ })).toHaveLength(4);
    expect(screen.queryByTestId("dismissed-guardrails")).toBeNull();
  });

  it("dispensar em todos os serviços (padrão) com a prova: os quatro somem e a seção dispensados aparece; voltar a avisar os traz de volta", async () => {
    render(<ProjectGuardrailNotices project={PROJECT} />);
    fireEvent.click((await screen.findAllByRole("button", { name: /Não procede/ }))[1]!);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("radio", { name: /todos os serviços/ })).toBeChecked();
    expect(within(dialog).getByRole("radio", { name: /Só no serviço api/ })).not.toBeChecked();
    const confirm = within(dialog).getByRole("button", { name: /Dispensar alerta/ });
    // bloqueio: só com senha e código
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Motivo/), { target: { value: "  não é senha " } });
    fireEvent.change(within(dialog).getByLabelText("Senha do painel"), { target: { value: "MinhaSenha123" } });
    fireEvent.change(document.getElementById("dismiss-code")!, { target: { value: "123456" } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(JSON.parse(String((posts()[0]![1] as RequestInit).body))).toEqual({
      finding: { rule: "weak-credentials", title: WARNINGS[1]!.message, service: "api", target: "CACHE_SALT" },
      scope: "project",
      reason: "não é senha",
      currentPassword: "MinhaSenha123",
      code: "123456",
    });
    expect(await screen.findByText(/Guardrails \(2\)/)).toBeInTheDocument();
    expect(screen.queryByText(/CACHE_SALT com valor fraco/)).toBeNull();

    const section = screen.getByTestId("dismissed-guardrails");
    expect(within(section).getByText("Alertas dispensados (1)")).toBeInTheDocument();
    // recolhida: o detalhe só aparece ao abrir
    expect(within(section).queryByText(/Voltar a avisar/)).toBeNull();
    fireEvent.click(within(section).getByRole("button", { expanded: false }));
    expect(within(section).getByText(/Dispensado por admin em/)).toBeInTheDocument();
    expect(within(section).getByText("Motivo: não é senha")).toBeInTheDocument();
    expect(within(section).getByText(/todos os serviços/)).toBeInTheDocument();
    fireEvent.click(within(section).getByRole("button", { name: /Voltar a avisar/ }));
    expect(await screen.findByText(/Guardrails \(6\)/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("dismissed-guardrails")).toBeNull());
  });

  it("aviso por e-mail não enviado aparece depois de dispensar", async () => {
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") return { dismissal: DISMISSED, alertWarning: "Alerta por e-mail não enviado: sem e-mail no perfil." };
      return { dismissals: [] };
    });
    render(<ProjectGuardrailNotices project={PROJECT} />);
    fireEvent.click((await screen.findAllByRole("button", { name: /Não procede/ }))[0]!);
    fireEvent.change(screen.getByLabelText("Senha do painel"), { target: { value: "x" } });
    fireEvent.change(document.getElementById("dismiss-code")!, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /Dispensar alerta/ }));
    expect(await screen.findByText(/Alerta por e-mail não enviado/)).toBeInTheDocument();
  });

  it("lista que não carrega (ou resposta estranha) não esconde nenhum aviso", async () => {
    apiFetchMock.mockImplementation(async () => {
      throw new Error("rede");
    });
    render(<ProjectGuardrailNotices project={PROJECT} />);
    expect(await screen.findByText(/Guardrails \(6\)/)).toBeInTheDocument();
    cleanup();
    apiFetchMock.mockImplementation(async () => ({}));
    render(<ProjectGuardrailNotices project={{ ...PROJECT, detection: null } as never} />);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(screen.queryByText(/Guardrails/)).toBeNull();
  });
});

describe("diálogo da dispensa", () => {
  it("aviso (sem bloqueio) não pede prova; achado sem serviço só vale para o projeto; erro do servidor fica no diálogo", async () => {
    apiFetchMock.mockRejectedValueOnce(new ApiRequestError(400, "not_dismissible", "Esta regra protege o painel."));
    const onDone = vi.fn();
    render(
      <GuardrailDismissDialog
        projectId="p1"
        finding={{ rule: "secret-in-code", title: "Possível secret", evidence: "app.js:3", target: "app.js" }}
        onClose={() => undefined}
        onDone={onDone}
      />,
    );
    expect(screen.queryByLabelText("Senha do painel")).toBeNull();
    expect(screen.getByRole("radio", { name: /não é de um serviço/ })).toBeDisabled();
    expect(screen.getByText(/variável\/alvo: app.js/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Dispensar alerta/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Esta regra protege o painel.");
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Dispensar alerta/ }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(null));
    const body = JSON.parse(String((apiFetchMock.mock.calls.at(-1)![1] as RequestInit).body));
    expect(body).toEqual({ finding: { rule: "secret-in-code", title: "Possível secret", evidence: "app.js:3", target: "app.js" }, scope: "project" });
  });

  it("só neste serviço: a escolha vai no pedido; cancelar fecha", async () => {
    const onClose = vi.fn();
    render(
      <GuardrailDismissDialog
        projectId="p1"
        finding={{ rule: "latest-tag", title: "Imagem sem versão", service: "web", target: "nginx" }}
        onClose={onClose}
        onDone={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: /Só no serviço web/ }));
    fireEvent.click(screen.getByRole("button", { name: /Dispensar alerta/ }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(String((posts()[0]![1] as RequestInit).body)).scope).toBe("service");
    fireEvent.click(screen.getByRole("button", { name: /Cancelar/ }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("seção Alertas dispensados", () => {
  it("dispensa de um serviço, sem motivo; erro ao voltar a avisar aparece na seção", async () => {
    apiFetchMock.mockRejectedValueOnce(new ApiRequestError(404, "dismissal_not_found", "Este alerta já não está dispensado."));
    const onRestored = vi.fn();
    const one: GuardrailDismissal = { ...DISMISSED, id: "d2", service: "api", reason: null, match: "evidence", value: 'compose.yml: serviço "*" monta /srv' };
    render(<DismissedGuardrailsSection projectId="p1" dismissals={[one]} onRestored={onRestored} />);
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText("Sem motivo informado.")).toBeInTheDocument();
    expect(screen.getByText(/serviço api/)).toBeInTheDocument();
    expect(screen.getByText('compose.yml: serviço "*" monta /srv')).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Voltar a avisar/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Este alerta já não está dispensado.");
    expect(onRestored).not.toHaveBeenCalled();
    // e recolhe de novo
    fireEvent.click(screen.getByRole("button", { expanded: true }));
    expect(screen.queryByText(/Voltar a avisar/)).toBeNull();
  });
});

const BLOCKED: GuardrailReport = {
  ranAt: "2026-11-06T12:00:00Z",
  dir: "/tmp/loja",
  findings: [
    { rule: "weak-credentials", level: "block", title: "Credencial fraca ou trivial em CACHE_SALT", evidence: 'compose.yml: serviço "web" define CACHE_SALT', fix: "Troque.", service: "web", target: "CACHE_SALT" },
    { rule: "privileged-container", level: "block", title: "Container privilegiado", evidence: 'compose.yml: serviço "web" define privileged: true', fix: "Remova.", service: "web" },
    { rule: "proxy-port-conflict", level: "block", title: "Porta 80", evidence: "e", fix: "f", service: "web" },
    { rule: "shared-resource", level: "block", title: "Volume de outro projeto", evidence: "e", fix: "f", service: "web" },
    { rule: "host-mount", level: "block", title: "Pasta do servidor montada", evidence: "e", fix: "f", service: "web" },
  ],
  blockers: 5,
  warnings: 0,
  infos: 0,
};

describe("diálogo de bloqueio do deploy", () => {
  it("sem o projeto não há a ação; com ele, só nos achados dispensáveis", () => {
    const { unmount } = render(<GuardrailOverrideModal report={BLOCKED} busy={false} onCancel={() => undefined} onConfirm={() => undefined} />);
    expect(screen.queryByRole("button", { name: /Não procede/ })).toBeNull();
    unmount();
    render(<GuardrailOverrideModal report={BLOCKED} busy={false} onCancel={() => undefined} onConfirm={() => undefined} projectId="p1" onDismissed={() => undefined} />);
    expect(screen.getAllByRole("button", { name: /Não procede/ })).toHaveLength(1);
  });

  it("sem bloqueios restantes: diz que pode seguir, mostra quantos foram dispensados e oferece o deploy comum", () => {
    const onDeploy = vi.fn();
    const onCancel = vi.fn();
    render(
      <GuardrailOverrideModal
        report={{ ...BLOCKED, findings: [], blockers: 0, dismissed: 2 }}
        busy={false}
        onCancel={onCancel}
        onConfirm={() => undefined}
        projectId="p1"
        onDismissed={() => undefined}
        onDeploy={onDeploy}
      />,
    );
    expect(screen.getByTestId("no-blockers")).toHaveTextContent(/sem override/);
    expect(screen.getByText(/2 alertas dispensados/)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /entendo os riscos/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Fazer o deploy/ }));
    expect(onDeploy).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Fechar/ }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("na página: dispensar no diálogo busca o relatório de novo e o deploy sai sem override", async () => {
    let dismissed = false;
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/projects/p1") {
        return { project: { ...PROJECT, detection: { ...PROJECT.detection, warnings: [] } }, status: "created", containers: [], url: null, credential: { configured: false, hint: null, username: null, updatedAt: null } };
      }
      if (path === "/api/projects/p1/jobs") return { jobs: [] };
      if (path === "/api/projects/p1/guardrails") {
        const findings = dismissed ? [] : [BLOCKED.findings[0]!];
        return { report: { ...BLOCKED, findings, blockers: findings.length, ...(dismissed ? { dismissed: 1 } : {}) }, note: null };
      }
      if (path === "/api/projects/p1/guardrails/dismissals" && init?.method === "POST") {
        dismissed = true;
        return { dismissal: DISMISSED, alertWarning: "Alerta por e-mail não enviado." };
      }
      if (path === "/api/projects/p1/guardrails/dismissals") return { dismissals: [] };
      if (path === "/api/projects/p1/deploy") {
        expect(JSON.parse(String(init?.body))).toEqual({ guardrailOverride: false });
        return { job: { id: "j1", projectId: "p1", status: "running", log: "", startedAt: "2026-11-06T12:00:00Z" } };
      }
      return {};
    });
    render(
      <MemoryRouter initialEntries={["/projects/p1?deploy=1"]}>
        <Routes>
          <Route path="/projects/:id/:section?" element={<ProjectDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Não procede/ }));
    fireEvent.change(within(screen.getByRole("dialog")).getByLabelText("Senha do painel"), { target: { value: "MinhaSenha123" } });
    fireEvent.change(document.getElementById("dismiss-code")!, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /Dispensar alerta/ }));
    expect(await screen.findByTestId("no-blockers")).toBeInTheDocument();
    expect(screen.getByText(/Alerta por e-mail não enviado/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Fazer o deploy/ }));
    await waitFor(() => expect(apiFetchMock.mock.calls.some(([p]) => p === "/api/projects/p1/deploy")).toBe(true));
  });

  it("na página: se o relatório não volta depois de dispensar, o motivo aparece no diálogo", async () => {
    let calls = 0;
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/projects/p1") {
        return { project: { ...PROJECT, detection: { ...PROJECT.detection, warnings: [] } }, status: "created", containers: [], url: null, credential: { configured: false, hint: null, username: null, updatedAt: null } };
      }
      if (path === "/api/projects/p1/jobs") return { jobs: [] };
      if (path === "/api/projects/p1/guardrails") {
        calls += 1;
        if (calls > 1) throw new Error("rede");
        return { report: { ...BLOCKED, findings: [BLOCKED.findings[0]!], blockers: 1 }, note: null };
      }
      if (path === "/api/projects/p1/guardrails/dismissals" && init?.method === "POST") return { dismissal: DISMISSED };
      return { dismissals: [] };
    });
    render(
      <MemoryRouter initialEntries={["/projects/p1?deploy=1"]}>
        <Routes>
          <Route path="/projects/:id/:section?" element={<ProjectDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Não procede/ }));
    fireEvent.change(within(screen.getByRole("dialog")).getByLabelText("Senha do painel"), { target: { value: "MinhaSenha123" } });
    fireEvent.change(document.getElementById("dismiss-code")!, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /Dispensar alerta/ }));
    expect(await screen.findByText(/não consegui buscar a lista atualizada/)).toBeInTheDocument();
  });
});

describe("assistente de novo projeto", () => {
  it("os avisos da detecção também têm a ação; dispensado some da lista", async () => {
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (path === "/api/projects" && method === "POST") return { project: { id: "p1", domain: "loja.localhost", name: "loja" } };
      if (path.startsWith("/api/domains/suggest")) return { auto: "loja.example.com", publicIp: null };
      if (path === "/api/projects/p1/detect") return { detection: { ...PROJECT.detection, warnings: WARNINGS.slice(0, 2) } };
      if (path === "/api/projects/p1/guardrails/dismissals" && method === "POST") {
        dismissals = [DISMISSED];
        return { dismissal: DISMISSED };
      }
      if (path === "/api/projects/p1/guardrails/dismissals") return { dismissals };
      return {};
    });
    render(
      <MemoryRouter initialEntries={["/new"]}>
        <Routes>
          <Route path="/new" element={<NewProjectPage />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByPlaceholderText("minha-app"), { target: { value: "loja" } });
    fireEvent.click(screen.getByRole("button", { name: /Repositório Git/ }));
    fireEvent.change(screen.getByPlaceholderText("https://github.com/usuario/repo.git"), { target: { value: "https://example.com/loja.git" } });
    fireEvent.click(screen.getByRole("button", { name: /Criar e detectar/ }));
    const buttons = await screen.findAllByRole("button", { name: /Não procede/ });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]!);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Cancelar/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: /Não procede/ })[0]!);
    fireEvent.change(within(screen.getByRole("dialog")).getByLabelText("Senha do painel"), { target: { value: "x" } });
    fireEvent.change(document.getElementById("dismiss-code")!, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /Dispensar alerta/ }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Não procede/ })).toBeNull());
  });
});
