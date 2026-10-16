/**
 * timezone-settings.test.tsx — Configurações → Fuso horário (API simulada):
 * fuso e hora da VPS, busca no seletor (Brasil primeiro, sem acento),
 * aplicar na VPS com os projetos marcados (marcar todos / nenhum), o motivo
 * quando não dá para aplicar e o TZ do .env. Também o fuso no assistente de
 * instalação (não trava se falhar) e o campo "Fuso horário" do projeto.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { timezoneOptions, type ProjectTimezoneView, type TimezoneStatus } from "@paas/core";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { ApiRequestError } from "@/lib/api";
import { TimezoneSettings, settingText, sourceText } from "@/pages/settings/TimezoneSettings";
import { SetupTimezoneCard } from "@/components/setup/SetupTimezoneCard";
import { ProjectTimezoneCard } from "@/components/project/ProjectTimezoneCard";
import { SETTINGS_SECTIONS } from "@/pages/settings/SettingsLayout";

const AT = new Date("2026-10-15T15:00:00Z");
const OPTIONS = timezoneOptions(AT);

let state: TimezoneStatus;
let project: ProjectTimezoneView;
let calls: Array<{ key: string; body: Record<string, unknown> }>;
let failures: Record<string, ApiRequestError | Error>;

function base(): TimezoneStatus {
  return {
    zone: "Europe/Berlin",
    offset: "UTC+2",
    source: "host",
    envOverride: null,
    hostZone: "Europe/Berlin",
    hostReadAt: AT.toISOString(),
    hostError: null,
    canApply: true,
    cannotApplyReason: null,
    now: AT.toISOString(),
    options: OPTIONS,
    projects: [
      { id: "p1", name: "Loja", setting: { mode: "image" }, effectiveZone: null },
      { id: "p2", name: "Blog", setting: { mode: "host" }, effectiveZone: "Europe/Berlin" },
      { id: "p3", name: "API", setting: { mode: "zone", zone: "Europe/Lisbon" }, effectiveZone: "Europe/Lisbon" },
    ],
  };
}

function baseProject(): ProjectTimezoneView {
  return {
    setting: { mode: "image" },
    effectiveZone: null,
    hostZone: "America/Sao_Paulo",
    definedByProject: [],
    appliedZone: null,
    pendingRestart: false,
    supported: true,
    services: [],
    options: OPTIONS,
  };
}

beforeEach(() => {
  state = base();
  project = baseProject();
  calls = [];
  failures = {};
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const key = `${method} ${path}`;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ key, body });
    if (failures[key]) throw failures[key];
    switch (key) {
      case "GET /api/timezone":
        return state;
      case "PUT /api/timezone": {
        const zone = String(body.zone);
        const ids = (body.projects as string[] | undefined) ?? [];
        state = {
          ...state,
          zone,
          hostZone: zone,
          projects: state.projects.map((p) => (ids.includes(p.id) ? { ...p, setting: { mode: "host" }, effectiveZone: zone } : p)),
        };
        return {
          status: state,
          projects: ids.map((id) =>
            id === "p3"
              ? { id, name: "API", jobId: null, error: "Faça o primeiro deploy do projeto: o fuso entra junto." }
              : { id, name: state.projects.find((p) => p.id === id)!.name, jobId: `job-${id}`, error: null },
          ),
        };
      }
      case "GET /api/projects/p1/timezone":
        return project;
      case "PUT /api/projects/p1/timezone": {
        const mode = body.mode as ProjectTimezoneView["setting"]["mode"];
        const zone = body.zone as string | undefined;
        const effective = mode === "image" ? null : mode === "host" ? project.hostZone : zone!;
        project = { ...project, setting: zone ? { mode, zone } : { mode }, effectiveZone: effective, pendingRestart: effective !== project.appliedZone };
        return project;
      }
      case "POST /api/projects/p1/recreate":
        return { job: { id: "job1", kind: "recreate" } };
      default:
        throw new Error(`rota inesperada: ${key}`);
    }
  });
});

afterEach(cleanup);

function renderPage() {
  return render(
    <MemoryRouter>
      <TimezoneSettings />
    </MemoryRouter>,
  );
}

async function pick(input: HTMLElement, search: string, option: RegExp) {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: search } });
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

describe("Configurações → Fuso horário", () => {
  it("aparece no menu de Configurações", () => {
    expect(SETTINGS_SECTIONS.map((s) => s.label)).toContain("Fuso horário");
  });

  it("mostra o fuso e a hora da VPS; busca sem acento acha São Paulo; aplica com os projetos marcados", async () => {
    renderPage();
    const card = await screen.findByTestId("timezone-card");
    expect(within(card).getByTestId("timezone-current")).toHaveTextContent("A VPS está em Europe/Berlin (UTC+2). Agora são 17:00 lá.");
    expect(within(card).getByRole("button", { name: "Aplicar na VPS" })).toBeDisabled();
    // Brasil primeiro na lista
    const input = within(card).getByLabelText("Fuso horário");
    fireEvent.click(input);
    const first = (await screen.findAllByRole("option"))[0]!;
    expect(first).toHaveTextContent("America/Sao Paulo — Brasil: Brasília, Sul, Sudeste, Goiás e DF");
    expect(first).toHaveTextContent("UTC−3");
    await pick(input, "sao paulo", /America\/Sao Paulo/);
    // marcar todos / nenhum
    const list = within(card).getByTestId("timezone-projects");
    expect(list).toHaveTextContent("Loja — hoje: Padrão da imagem");
    expect(list).toHaveTextContent("API — hoje: Europe/Lisbon");
    expect(list).toHaveTextContent("Blog segue o fuso da VPS, mas só pega o fuso novo depois de reiniciar ou reimplantar.");
    fireEvent.click(within(list).getByRole("button", { name: "Marcar todos" }));
    expect(within(list).getAllByRole("checkbox").every((c) => (c as HTMLInputElement).checked)).toBe(true);
    fireEvent.click(within(list).getByRole("button", { name: "Nenhum" }));
    expect(within(list).getAllByRole("checkbox").some((c) => (c as HTMLInputElement).checked)).toBe(false);
    fireEvent.click(within(list).getByLabelText(/Loja/));
    fireEvent.click(within(list).getByLabelText(/API/));
    fireEvent.click(within(card).getByRole("button", { name: "Aplicar na VPS" }));
    expect(await within(card).findByRole("status")).toHaveTextContent(
      "A VPS agora está em America/Sao_Paulo (UTC−3). O painel e a agenda dos backups já usam esse fuso.",
    );
    expect(calls.find((c) => c.key === "PUT /api/timezone")!.body).toEqual({ zone: "America/Sao_Paulo", projects: ["p1", "p3"] });
    const results = within(card).getByTestId("timezone-project-results");
    expect(results).toHaveTextContent("Loja: reiniciando com o fuso novo. Acompanhe em Deploys.");
    expect(within(results).getByRole("link", { name: "Acompanhe em Deploys" })).toHaveAttribute("href", "/projects/p1/deploys");
    expect(results).toHaveTextContent("API: não reiniciou — Faça o primeiro deploy do projeto: o fuso entra junto.");
    expect(within(card).getByTestId("timezone-current")).toHaveTextContent("A VPS está em America/Sao_Paulo (UTC−3). Agora são 12:00 lá.");
  });

  it("sem host bridge: explica por quê e o botão fica desligado", async () => {
    state = { ...base(), canApply: false, cannotApplyReason: "O painel não está ligado à VPS (PAAS_TARGET não é host).", source: "localtime" };
    renderPage();
    expect(await screen.findByTestId("timezone-cannot-apply")).toHaveTextContent("PAAS_TARGET não é host");
    expect(screen.getByRole("button", { name: "Aplicar na VPS" })).toBeDisabled();
    expect(screen.getByLabelText("Fuso horário")).toBeDisabled();
    expect(screen.getByTestId("timezone-current")).toHaveTextContent("pode estar desatualizado");
  });

  it("TZ no .env: avisa que ele manda; erro da VPS aparece; erro ao carregar também", async () => {
    state = { ...base(), source: "env", envOverride: "America/Manaus", zone: "America/Manaus" };
    failures["PUT /api/timezone"] = new ApiRequestError(502, "timezone_apply_failed", "A VPS não aceitou o fuso novo: Access denied");
    renderPage();
    const current = await screen.findByTestId("timezone-current");
    expect(current).toHaveTextContent("O painel está usando America/Manaus (UTC−4).");
    expect(current).toHaveTextContent("O arquivo /opt/tws-panel/.env define TZ=America/Manaus.");
    await pick(screen.getByLabelText("Fuso horário"), "recife", /America\/Recife/);
    fireEvent.click(screen.getByRole("button", { name: "Aplicar na VPS" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A VPS não aceitou o fuso novo: Access denied");
    cleanup();
    failures["GET /api/timezone"] = new Error("rede");
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível concluir agora.");
  });

  it("textos de origem e da escolha do projeto", () => {
    expect(sourceText({ ...base(), source: "saved" })).toMatch(/Último fuso lido/);
    expect(sourceText({ ...base(), source: "default" })).toMatch(/usa UTC/);
    expect(sourceText(base())).toBeNull();
    expect(settingText({ mode: "zone" })).toBe("Padrão da imagem");
    expect(settingText({ mode: "host" })).toBe("Igual ao da VPS");
  });
});

describe("assistente de instalação", () => {
  it("mostra o fuso detectado e troca pelo mesmo endpoint", async () => {
    render(<SetupTimezoneCard />);
    const card = await screen.findByTestId("setup-timezone");
    expect(await within(card).findByText(/Europe\/Berlin \(UTC\+2\)/)).toBeInTheDocument();
    expect(card).toHaveTextContent("(17:00 agora). Os backups rodam às 03:00 nesse fuso.");
    fireEvent.click(within(card).getByRole("button", { name: "Trocar o fuso" }));
    expect(within(card).getByRole("button", { name: /Aplicar na VPS/ })).toBeDisabled();
    await pick(within(card).getByLabelText("Fuso horário"), "manaus", /America\/Manaus/);
    fireEvent.click(within(card).getByRole("button", { name: /Aplicar na VPS/ }));
    expect(await within(card).findByText("Fuso trocado.")).toBeInTheDocument();
    expect(card).toHaveTextContent("America/Manaus (UTC−4)");
    expect(calls.find((c) => c.key === "PUT /api/timezone")!.body).toEqual({ zone: "America/Manaus" });
  });

  it("não trava: falha ao ler ou ao trocar só explica", async () => {
    failures["PUT /api/timezone"] = new ApiRequestError(409, "host_bridge_unavailable", "O painel não está ligado à VPS.");
    render(<SetupTimezoneCard />);
    const card = await screen.findByTestId("setup-timezone");
    fireEvent.click(await within(card).findByRole("button", { name: "Trocar o fuso" }));
    await pick(within(card).getByLabelText("Fuso horário"), "bahia", /America\/Bahia — Brasil/);
    fireEvent.click(within(card).getByRole("button", { name: /Aplicar na VPS/ }));
    expect(await within(card).findByRole("alert")).toHaveTextContent(
      "O painel não está ligado à VPS. Você pode continuar e trocar depois em Configurações → Fuso horário.",
    );
    fireEvent.click(within(card).getByRole("button", { name: "Cancelar" }));
    cleanup();
    failures["GET /api/timezone"] = new Error("rede");
    render(<SetupTimezoneCard />);
    expect(await screen.findByText(/Não deu para ler o fuso agora/)).toBeInTheDocument();
    cleanup();
    delete failures["GET /api/timezone"];
    state = { ...base(), canApply: false, cannotApplyReason: "Troque o fuso pelo SSH." };
    render(<SetupTimezoneCard />);
    expect(await screen.findByText("Troque o fuso pelo SSH.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Trocar o fuso" })).not.toBeInTheDocument();
  });
});

describe("Fuso horário do projeto", () => {
  function renderCard(onChanged = vi.fn()) {
    render(
      <MemoryRouter>
        <ProjectTimezoneCard projectId="p1" onChanged={onChanged} />
      </MemoryRouter>,
    );
    return onChanged;
  }

  it("três escolhas; salvar pede reiniciar; o botão reinicia e aponta Deploys", async () => {
    const onChanged = renderCard();
    const card = await screen.findByTestId("project-timezone-card");
    expect(within(card).getByLabelText(/Padrão da imagem \(geralmente UTC\)/)).toBeChecked();
    expect(card).toHaveTextContent("Hoje America/Sao_Paulo (UTC−3). Acompanha quando você troca o fuso da VPS.");
    expect(within(card).getByRole("button", { name: /Salvar/ })).toBeDisabled();
    fireEvent.click(within(card).getByLabelText(/Igual ao da VPS/));
    fireEvent.click(within(card).getByRole("button", { name: /Salvar/ }));
    expect(await within(card).findByText("Fuso salvo.")).toBeInTheDocument();
    expect(calls.find((c) => c.key === "PUT /api/projects/p1/timezone")!.body).toEqual({ mode: "host" });
    const pending = within(card).getByTestId("timezone-pending");
    expect(pending).toHaveTextContent("A escolha vale depois de reiniciar os containers (passam a usar America/Sao_Paulo (UTC−3)). O reinício não baixa código novo.");
    fireEvent.click(within(pending).getByRole("button", { name: /Reiniciar com o fuso novo/ }));
    expect(await within(card).findByRole("status")).toHaveTextContent("Reiniciando com o fuso novo. Acompanhe em Deploys.");
    expect(onChanged).toHaveBeenCalled();
    // um fuso específico
    fireEvent.click(within(card).getByLabelText(/Um fuso específico/));
    await pick(within(card).getByLabelText("Fuso do projeto"), "lisbon", /Europe\/Lisbon/);
    fireEvent.click(within(card).getByRole("button", { name: /Salvar/ }));
    await waitFor(() => expect(calls.filter((c) => c.key === "PUT /api/projects/p1/timezone").at(-1)!.body).toEqual({ mode: "zone", zone: "Europe/Lisbon" }));
    expect(await within(card).findByTestId("timezone-pending")).toHaveTextContent("Europe/Lisbon (UTC+1)");
    // voltar ao da imagem
    fireEvent.click(within(card).getByLabelText(/Padrão da imagem/));
    fireEvent.click(within(card).getByRole("button", { name: /Salvar/ }));
    // nada foi aplicado ainda: voltar ao da imagem não pede reinício
    await waitFor(() => expect(within(card).queryByTestId("timezone-pending")).toBeNull());
  });

  it("mostra quem já define TZ e o serviço sem tzdata; reinício recusado mostra o motivo", async () => {
    project = {
      ...baseProject(),
      setting: { mode: "zone", zone: "America/Recife" },
      effectiveZone: "America/Recife",
      pendingRestart: true,
      definedByProject: [
        { service: "worker", value: "Europe/Lisbon", where: "compose" },
        { service: "db", value: "UTC", where: "variables" },
        { service: "cron", value: "Asia/Tokyo", where: "env_file" },
      ],
      services: [
        { service: "web", container: "paas-loja-web-1", running: true, tz: "America/Recife", zoneinfo: false },
        { service: "api", container: "paas-loja-api-1", running: true, tz: "America/Recife", zoneinfo: true },
      ],
    };
    failures["POST /api/projects/p1/recreate"] = new ApiRequestError(409, "deploy_in_progress", "Já existe um deploy em andamento.");
    renderCard();
    const card = await screen.findByTestId("project-timezone-card");
    expect(within(card).getByLabelText(/Um fuso específico/)).toBeChecked();
    const defined = within(card).getByTestId("timezone-defined");
    expect(defined).toHaveTextContent("worker: Europe/Lisbon (no compose)");
    expect(defined).toHaveTextContent("db: UTC (nas Variáveis)");
    expect(defined).toHaveTextContent("cron: Asia/Tokyo (num arquivo env_file)");
    const warn = within(card).getByTestId("timezone-no-tzdata");
    expect(warn).toHaveTextContent("web: este serviço ignora o fuso; instale tzdata na imagem.");
    expect(warn).not.toHaveTextContent("api:");
    fireEvent.click(within(card).getByRole("button", { name: /Reiniciar com o fuso novo/ }));
    expect(await within(card).findByRole("alert")).toHaveTextContent("Já existe um deploy em andamento.");
  });

  it("site estático não tem fuso; erro ao carregar aparece", async () => {
    project = { ...baseProject(), supported: false };
    renderCard();
    expect(await screen.findByText(/Site estático não tem processo rodando/)).toBeInTheDocument();
    cleanup();
    failures["GET /api/projects/p1/timezone"] = new ApiRequestError(404, "project_not_found", "Projeto não encontrado.");
    renderCard();
    expect(await screen.findByRole("alert")).toHaveTextContent("Projeto não encontrado.");
  });
});
