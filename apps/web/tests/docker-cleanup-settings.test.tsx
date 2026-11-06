/**
 * docker-cleanup-settings.test.tsx — Configurações → Limpeza do Docker: verificador, listas, aviso,
 * "Limpar agora" com confirmação, bloqueios, configuração automática (desligada por padrão) e histórico.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOCKER_CLEANUP_DEFAULTS, DOCKER_CLEANUP_LIMITS, type DockerCleanupRecord, type DockerCleanupScan, type DockerCleanupState } from "@paas/core";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { ApiRequestError } from "@/lib/api";
import { setLocale } from "@/i18n/core";
import { DockerCleanupSettings } from "@/pages/settings/DockerCleanupSettings";

const GB = 1024 ** 3;
const scanOf = (over: Partial<DockerCleanupScan> = {}): DockerCleanupScan => ({
  scannedAt: "2026-11-05T12:00:00Z",
  minAgeDays: 7,
  buildCache: { bytes: 5 * GB, entries: 3, totalBytes: 8 * GB },
  images: {
    bytes: 4 * GB,
    candidates: [{ id: "sha256:aaaaaaaaaaaaaaaa", tags: ["meu-app:antigo"], bytes: 4 * GB, createdAt: "2026-09-01T00:00:00Z", ageDays: 60 }],
    protected: [
      { id: "sha256:bbbbbbbbbbbbbbbb", tags: ["tws-panel:1"], bytes: GB, createdAt: "2026-09-01T00:00:00Z", ageDays: 60, reason: "panel" },
      { id: "sha256:cccccccccccccccc", tags: [], bytes: GB, createdAt: "2026-09-01T00:00:00Z", ageDays: 60, reason: "in_use" },
    ],
  },
  totalBytes: 9 * GB,
  totalPercentOfDisk: 9,
  disk: { totalBytes: 100 * GB, usedBytes: 85 * GB, usedPercent: 85 },
  ...over,
});
const stateOf = (over: Partial<DockerCleanupState> = {}): DockerCleanupState => ({
  settings: { ...DOCKER_CLEANUP_DEFAULTS },
  defaults: { ...DOCKER_CLEANUP_DEFAULTS },
  limits: DOCKER_CLEANUP_LIMITS,
  lastScan: scanOf(),
  working: false,
  blocked: null,
  warning: false,
  nextRunAt: null,
  history: [],
  ...over,
});
const record = (over: Partial<DockerCleanupRecord> = {}): DockerCleanupRecord => ({
  id: "r1",
  at: "2026-11-05T13:00:00Z",
  trigger: "manual",
  actor: "ana",
  result: "success",
  minAgeDays: 7,
  buildCacheBytes: 5 * GB,
  imagesBytes: 4 * GB,
  freedBytes: 9 * GB,
  removedImages: ["meu-app:antigo"],
  errors: [],
  ...over,
});

const serve = (initial: DockerCleanupState, extra: (path: string, init?: RequestInit) => unknown = () => undefined) => {
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    const custom = extra(path, init);
    if (custom !== undefined) {
      if (custom instanceof Error) throw custom;
      return custom;
    }
    if (path === "/api/docker-cleanup") return initial;
    throw new Error(`rota inesperada ${path}`);
  });
};

beforeEach(() => {
  setLocale("pt-BR");
  apiFetchMock.mockReset();
});
afterEach(cleanup);

describe("verificador", () => {
  it("mostra cache, imagens, total, % do disco, data e as duas listas", async () => {
    serve(stateOf());
    render(<DockerCleanupSettings />);
    expect(await screen.findByTestId("docker-cleanup-total")).toHaveTextContent("9 GB");
    expect(screen.getByTestId("docker-cleanup-total")).toHaveTextContent("9% do disco");
    expect(screen.getByTestId("docker-cleanup-last-scan")).toHaveTextContent(/Última verificação/);
    expect(screen.getByText("meu-app:antigo")).toBeInTheDocument();
    const protectedList = screen.getByTestId("docker-cleanup-protected-list");
    expect(within(protectedList).getByText(/do painel/)).toBeInTheDocument();
    expect(within(protectedList).getByText(/usada por um contêiner/)).toBeInTheDocument();
    expect(screen.getByText(/Disco em uso agora: 85%/)).toBeInTheDocument();
  });

  it("sem verificação, avisa e trava o Limpar agora; Verificar agora atualiza", async () => {
    serve(stateOf({ lastScan: null }), (path) => (path === "/api/docker-cleanup/scan" ? stateOf({ warning: true }) : undefined));
    render(<DockerCleanupSettings />);
    expect(await screen.findByText("Ainda não foi verificado.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Limpar agora" })).toBeDisabled();
    expect(screen.queryByTestId("docker-cleanup-warning")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Verificar agora" }));
    expect(await screen.findByTestId("docker-cleanup-warning")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Limpar agora" })).toBeEnabled();
  });

  it("nada para limpar: mensagem e botão travado", async () => {
    serve(stateOf({ lastScan: scanOf({ totalBytes: 0, totalPercentOfDisk: 0, disk: null, images: { bytes: 0, candidates: [], protected: [] }, buildCache: { bytes: 0, entries: 0, totalBytes: 0 } }) }));
    render(<DockerCleanupSettings />);
    expect(await screen.findByText(/Nada para limpar/)).toBeInTheDocument();
    expect(screen.getAllByText("Nenhuma.")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Limpar agora" })).toBeDisabled();
  });

  it("erros do verificador: Docker fora e falha genérica", async () => {
    serve(stateOf(), (path) => (path === "/api/docker-cleanup/scan" ? new ApiRequestError(503, "docker_unavailable", "x") : undefined));
    render(<DockerCleanupSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Verificar agora" }));
    expect(await screen.findByText("O Docker não respondeu.")).toBeInTheDocument();
    serve(stateOf(), (path) => (path === "/api/docker-cleanup/scan" ? new Error("rede") : undefined));
    fireEvent.click(screen.getByRole("button", { name: "Verificar agora" }));
    expect(await screen.findByText(/Não foi possível verificar agora/)).toBeInTheDocument();
  });

  it("falha ao carregar mostra o erro", async () => {
    apiFetchMock.mockRejectedValue(new Error("x"));
    render(<DockerCleanupSettings />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível carregar");
  });
});

describe("plurais (singular e plural de verdade, sem \"(s)\")", () => {
  const imagem = (i: number) => ({ id: `sha256:${i}`, tags: [`app:${i}`], bytes: GB, createdAt: "2026-09-01T00:00:00Z", ageDays: i === 1 ? 1 : 63 });

  it("pt-BR: 1 item / 3 itens, 1 imagem / 48 imagens, 1 dia / 63 dias", async () => {
    const um = scanOf({ minAgeDays: 1, buildCache: { bytes: GB, entries: 1, totalBytes: GB }, images: { bytes: GB, candidates: [imagem(1)], protected: [] } });
    serve(stateOf({ lastScan: um }));
    const { unmount } = render(<DockerCleanupSettings />);
    expect(await screen.findByText(/em 1 item$/)).toBeInTheDocument();
    expect(screen.getByText(/em 1 imagem$/)).toBeInTheDocument();
    expect(screen.getByText(/mínima de 1 dia\./)).toBeInTheDocument();
    expect(screen.getByText(/· 1 dia$/)).toBeInTheDocument();
    unmount();

    const muitos = scanOf({
      minAgeDays: 7,
      buildCache: { bytes: GB, entries: 63, totalBytes: GB },
      images: { bytes: GB, candidates: Array.from({ length: 48 }, (_, i) => imagem(i + 2)), protected: [] },
    });
    serve(stateOf({ lastScan: muitos }));
    render(<DockerCleanupSettings />);
    expect(await screen.findByText(/em 63 itens$/)).toBeInTheDocument();
    expect(screen.getByText(/em 48 imagens$/)).toBeInTheDocument();
    expect(screen.getByText(/mínima de 7 dias\./)).toBeInTheDocument();
    expect(screen.getAllByText(/· 63 dias$/).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/\((s|ns)\)/);
  });

  it("en: 1 item / 63 items, 1 image / 48 images, 1 day / 7 days", async () => {
    setLocale("en");
    const um = scanOf({ minAgeDays: 1, buildCache: { bytes: GB, entries: 1, totalBytes: GB }, images: { bytes: GB, candidates: [imagem(1)], protected: [] } });
    serve(stateOf({ lastScan: um }));
    const { unmount } = render(<DockerCleanupSettings />);
    expect(await screen.findByText(/in 1 item$/)).toBeInTheDocument();
    expect(screen.getByText(/in 1 image$/)).toBeInTheDocument();
    expect(screen.getByText(/minimum age of 1 day\./)).toBeInTheDocument();
    unmount();
    serve(stateOf({ lastScan: scanOf({ minAgeDays: 7, buildCache: { bytes: GB, entries: 63, totalBytes: GB }, images: { bytes: GB, candidates: [imagem(2), imagem(3)], protected: [] } }) }));
    render(<DockerCleanupSettings />);
    expect(await screen.findByText(/in 63 items$/)).toBeInTheDocument();
    expect(screen.getByText(/in 2 images$/)).toBeInTheDocument();
    expect(screen.getByText(/minimum age of 7 days\./)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\((s|ns)\)/);
  });
});

describe("limpar agora", () => {
  it("pede confirmação mostrando o que será removido, e só então limpa", async () => {
    const after = stateOf({ history: [record()], lastScan: scanOf({ totalBytes: 0, totalPercentOfDisk: 0, images: { bytes: 0, candidates: [], protected: [] }, buildCache: { bytes: 0, entries: 0, totalBytes: 0 } }) });
    serve(stateOf(), (path, init) => (path === "/api/docker-cleanup/run" ? { record: record(), state: after, body: init?.body } : undefined));
    render(<DockerCleanupSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Limpar agora" }));
    const dialog = await screen.findByTestId("docker-cleanup-confirm");
    expect(dialog).toHaveTextContent("1 imagem (");
    expect(dialog).toHaveTextContent("Só sai o que está nesta lista.");
    expect(within(dialog).getByText("meu-app:antigo")).toBeInTheDocument();
    expect(apiFetchMock.mock.calls.some((c) => c[0] === "/api/docker-cleanup/run")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByTestId("docker-cleanup-confirm")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Limpar agora" }));
    fireEvent.click(within(await screen.findByTestId("docker-cleanup-confirm")).getByRole("button", { name: "Sim, limpar agora" }));
    expect(await screen.findByText("Limpeza concluída: 9 GB liberados.")).toBeInTheDocument();
    const call = apiFetchMock.mock.calls.find((c) => c[0] === "/api/docker-cleanup/run")!;
    // vai a lista que a pessoa viu: o servidor só remove o que estiver nela
    expect(JSON.parse(call[1].body)).toEqual({ confirm: true, imageIds: ["sha256:aaaaaaaaaaaaaaaa"], buildCache: true, minAgeDays: 7 });
    expect(screen.getByTestId("docker-cleanup-history")).toHaveTextContent("Manual");
  });

  it("resultado parcial, falha total e recusa por deploy", async () => {
    for (const [result, expected] of [
      ["partial", /Limpeza concluída com falhas/],
      ["failed", /não conseguiu remover nada/],
    ] as const) {
      cleanup();
      serve(stateOf(), (path) => (path === "/api/docker-cleanup/run" ? { record: record({ result, freedBytes: 0, errors: ["x: em uso"] }), state: stateOf({ history: [record({ result, errors: ["x: em uso"] })] }) } : undefined));
      render(<DockerCleanupSettings />);
      fireEvent.click(await screen.findByRole("button", { name: "Limpar agora" }));
      fireEvent.click(await screen.findByRole("button", { name: "Sim, limpar agora" }));
      expect(await screen.findByText(expected)).toBeInTheDocument();
      expect(screen.getByText("Falhas")).toBeInTheDocument();
    }
    cleanup();
    serve(stateOf(), (path) => (path === "/api/docker-cleanup/run" ? new ApiRequestError(409, "cleanup_deploy", "x") : undefined));
    render(<DockerCleanupSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Limpar agora" }));
    fireEvent.click(await screen.findByRole("button", { name: "Sim, limpar agora" }));
    expect(await screen.findByText("Há um deploy em andamento. Espere terminar para limpar.")).toBeInTheDocument();
    serve(stateOf(), (path) => (path === "/api/docker-cleanup/run" ? new Error("rede") : undefined));
    fireEvent.click(await screen.findByRole("button", { name: "Limpar agora" }));
    fireEvent.click(await screen.findByRole("button", { name: "Sim, limpar agora" }));
    expect(await screen.findByText(/Não foi possível limpar agora/)).toBeInTheDocument();
  });

  it("durante deploy ou backup o botão fica travado e o motivo aparece", async () => {
    serve(stateOf({ blocked: "deploy" }));
    render(<DockerCleanupSettings />);
    expect(await screen.findByTestId("docker-cleanup-blocked")).toHaveTextContent("deploy em andamento");
    expect(screen.getByRole("button", { name: "Limpar agora" })).toBeDisabled();
    cleanup();
    serve(stateOf({ blocked: "backup" }));
    render(<DockerCleanupSettings />);
    expect(await screen.findByTestId("docker-cleanup-blocked")).toHaveTextContent("backup");
  });
});

describe("limpeza automática", () => {
  it("vem desligada; ligar e salvar manda a configuração inteira", async () => {
    const saved = stateOf({ settings: { ...DOCKER_CLEANUP_DEFAULTS, enabled: true, minAgeDays: 14 }, nextRunAt: "2026-11-12T12:00:00Z" });
    serve(stateOf(), (path) => (path === "/api/docker-cleanup/settings" ? saved : undefined));
    render(<DockerCleanupSettings />);
    const box = (await screen.findByLabelText("Limpar automaticamente")) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.getByTestId("docker-cleanup-auto-state")).toHaveTextContent("desligada");
    fireEvent.click(box);
    fireEvent.change(screen.getByLabelText("Idade mínima (dias)"), { target: { value: "14" } });
    fireEvent.change(screen.getByLabelText("Frequência"), { target: { value: "monthly" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(await screen.findByText("Configuração salva.")).toBeInTheDocument();
    const call = apiFetchMock.mock.calls.find((c) => c[0] === "/api/docker-cleanup/settings")!;
    expect(call[1].method).toBe("PUT");
    expect(JSON.parse(call[1].body).settings).toMatchObject({ enabled: true, minAgeDays: 14, frequency: "monthly", diskTriggerPercent: null });
    expect(screen.getByTestId("docker-cleanup-auto-state")).toHaveTextContent("Próxima limpeza automática");
  });

  it("gatilho por disco liga com 90% e permite ajustar os avisos", async () => {
    serve(stateOf(), (path) => (path === "/api/docker-cleanup/settings" ? stateOf({ settings: { ...DOCKER_CLEANUP_DEFAULTS, diskTriggerPercent: 90 } }) : undefined));
    render(<DockerCleanupSettings />);
    fireEvent.click(await screen.findByLabelText("Limpar também quando o disco passar de um uso"));
    expect((screen.getByLabelText("Uso do disco (%)") as HTMLInputElement).value).toBe("90");
    fireEvent.change(screen.getByLabelText("Avisar quando der para liberar (GB)"), { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText("Avisar quando o disco passar de (%)"), { target: { value: "75" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await screen.findByText("Configuração salva.");
    const body = JSON.parse(apiFetchMock.mock.calls.find((c) => c[0] === "/api/docker-cleanup/settings")![1].body).settings;
    expect(body).toMatchObject({ diskTriggerPercent: 90, warnGainGb: 20, warnDiskPercent: 75 });
    fireEvent.click(screen.getByLabelText("Limpar também quando o disco passar de um uso"));
    expect(screen.queryByLabelText("Uso do disco (%)")).toBeNull();
  });

  it("valor fora do limite não é enviado; erro do servidor é explicado", async () => {
    serve(stateOf(), (path) => (path === "/api/docker-cleanup/settings" ? new ApiRequestError(400, "invalid_settings", "x") : undefined));
    render(<DockerCleanupSettings />);
    fireEvent.change(await screen.findByLabelText("Idade mínima (dias)"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("fora dos limites");
    expect(apiFetchMock.mock.calls.some((c) => c[0] === "/api/docker-cleanup/settings")).toBe(false);
    fireEvent.change(screen.getByLabelText("Idade mínima (dias)"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Idade mínima (dias)"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(apiFetchMock.mock.calls.some((c) => c[0] === "/api/docker-cleanup/settings")).toBe(true));
    expect(await screen.findByText(/fora dos limites/)).toBeInTheDocument();
    serve(stateOf(), (path) => (path === "/api/docker-cleanup/settings" ? new Error("rede") : undefined));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(await screen.findByText(/Nada foi alterado/)).toBeInTheDocument();
  });
});

describe("histórico", () => {
  it("lista data, origem, resultado, o que saiu e as falhas; vazio avisa", async () => {
    serve(stateOf({ history: [record({ trigger: "schedule", actor: "automática", result: "partial", errors: ["y: em uso"] }), record({ id: "r2", trigger: "disk" })] }));
    render(<DockerCleanupSettings />);
    const list = await screen.findByTestId("docker-cleanup-history");
    expect(list).toHaveTextContent("Automática (agenda)");
    expect(list).toHaveTextContent("Automática (disco cheio)");
    expect(list).toHaveTextContent("Com falhas");
    expect(within(list).getAllByText("Imagens removidas")).toHaveLength(2);
    cleanup();
    serve(stateOf());
    render(<DockerCleanupSettings />);
    expect(await screen.findByText("Nenhuma limpeza feita ainda.")).toBeInTheDocument();
  });
});

describe("idioma", () => {
  it("em inglês os textos acompanham", async () => {
    setLocale("en");
    serve(stateOf());
    render(<DockerCleanupSettings />);
    expect(await screen.findByRole("button", { name: "Check now" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clean now" })).toBeInTheDocument();
    setLocale("pt-BR");
  });
});
