/**
 * project-backups.test.tsx — aba Backups do projeto: o que foi detectado
 * (bancos, volumes com tamanho e motivo, coberto pelo dump), o aviso de
 * arquivos fora de volume, marcar/desmarcar e adicionar pasta (salvo de uma
 * vez), detectar de novo, fazer backup agora e restaurar.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackupsStatus, ProjectBackupView } from "@paas/core";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { setLocale } from "@/i18n/core";
import { ProjectBackupsCard } from "@/components/project/ProjectBackupsCard";

let view: ProjectBackupView;
let calls: Array<{ key: string; body: unknown }>;

function baseView(): ProjectBackupView {
  return {
    target: {
      id: "project:p1",
      kind: "project",
      name: "Loja",
      folder: "loja",
      enabled: true,
      frequencyHours: 24,
      localKeep: 2,
      remoteKeep: 5,
      lastBackup: null,
      lastSuccessAt: null,
      lastRemoteVerifiedAt: null,
      nextRunAt: null,
      available: true,
      followsDefaults: true,
    },
    detection: {
      detectedAt: "2026-10-14T12:00:00Z",
      databases: [
        { id: "db:db", service: "db", engine: "postgres", image: "postgres:16", databaseName: "loja", user: "app", defaultSelected: true, method: "Dump de cada banco com pg_dump (arquivo .sql), feito dentro do container." },
        { id: "db:cache", service: "cache", engine: "redis", image: "redis:7", databaseName: null, user: null, defaultSelected: false, method: "Cópia do arquivo de dados do Redis." },
      ],
      mounts: [
        { id: "mnt:db:/var/lib/postgresql/data", service: "db", type: "volume", source: "paas-loja_pg", destination: "/var/lib/postgresql/data", sizeBytes: 50 * 1024 ** 2, coveredByDump: true, isFile: false, defaultSelected: false, reason: "Coberto pelo dump do banco." },
        { id: "mnt:web:/app/uploads", service: "web", type: "volume", source: "paas-loja_uploads", destination: "/app/uploads", sizeBytes: 3 * 1024 ** 3, coveredByDump: false, isFile: false, defaultSelected: true, reason: "Parece guardar arquivos dos usuários (uploads, storage, dados)." },
        { id: "mnt:web:/app/cache", service: "web", type: "volume", source: "paas-loja_cache", destination: "/app/cache", sizeBytes: 8192, coveredByDump: false, isFile: false, defaultSelected: false, reason: "Parece cache ou arquivos temporários: dá para recriar." },
      ],
      unsavedWrites: [{ service: "web", count: 2, samples: ["/app/notas/1.pdf", "/app/notas/2.pdf"] }],
      sourceFolder: null,
      error: null,
    },
    choices: {},
    extraFolders: [],
    history: [],
    destinationConnected: false,
  };
}

const BASE_STATUS = { timezone: "UTC-03:00", backupHour: 3, archiverAvailable: true } as unknown as BackupsStatus;
let STATUS: BackupsStatus;
/** Resposta de GET /api/projects/p1/email (undefined = a consulta falha). */
let emailRes: { email: { enabled: boolean } } | undefined;

function emailTarget(over: Record<string, unknown> = {}) {
  return { id: "email", kind: "email", name: "E-mail", enabled: true, available: true, frequencyHours: 24, lastSuccessAt: null, lastRemoteVerifiedAt: null, ...over };
}

beforeEach(() => {
  setLocale("pt-BR");
  view = baseView();
  STATUS = BASE_STATUS;
  emailRes = { email: { enabled: false } };
  calls = [];
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const key = `${method} ${path}`;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ key, body });
    switch (key) {
      case "GET /api/backups/projects/p1":
        return view;
      case "GET /api/backups":
        return STATUS;
      case "GET /api/projects/p1/email":
        if (!emailRes) throw new Error("sem e-mail");
        return emailRes;
      case "PUT /api/backups/targets/project:p1":
        view = { ...view, choices: { ...view.choices, ...(body.choices ?? {}) }, extraFolders: (body.extraFolders ?? view.extraFolders).map((f: { service: string; path: string }) => ({ id: `extra:${f.service}:${f.path}`, ...f })) };
        return undefined;
      case "POST /api/backups/targets/project:p1/use-defaults":
        view = { ...view, target: { ...view.target, followsDefaults: true, frequencyHours: 6 } };
        return undefined;
      case "POST /api/backups/projects/p1/detect":
        return view;
      case "POST /api/backups/targets/email/run":
        return {};
      case "POST /api/backups/targets/project:p1/run":
        view = {
          ...view,
          target: { ...view.target, lastBackup: { id: "r1", target: "project:p1", targetName: "Loja", operation: "backup", trigger: "manual", status: "success", queuedAt: "2026-10-14T12:00:00Z", startedAt: null, finishedAt: "2026-10-14T12:01:00Z", fileName: "2026-10-14_09-00.7z", sizeBytes: 1000, local: true, remote: "none", remoteEncrypted: false, remoteDetail: null, steps: [], warnings: [], error: null } },
        };
        view.history = [view.target.lastBackup!];
        return view.target.lastBackup;
      case "GET /api/backups/targets/project:p1/points":
        return { points: [] };
      case "POST /api/backups/targets/project:p1/verify": {
        const v = { ...view.history[0]!, id: `v${calls.length}`, operation: "verify" as const, status: "running" as const, fileName: body.fileName ?? null, verify: { items: [], summary: { ok: 0, failed: 0, missing: 0, needsPassword: 0 } } };
        view = { ...view, history: [v, ...view.history] };
        return v;
      }
      default:
        throw new Error(`rota inesperada: ${key}`);
    }
  });
});

afterEach(cleanup);

function renderCard() {
  return render(
    <MemoryRouter>
      <ProjectBackupsCard projectId="p1" projectName="Loja" />
    </MemoryRouter>,
  );
}

describe("aba Backups do projeto", () => {
  it("mostra o detectado com tamanhos, motivos e o aviso de arquivos fora de volume", async () => {
    renderCard();
    const root = await screen.findByTestId("project-backups");
    expect(root).toHaveTextContent("PostgreSQL · serviço db");
    expect(root).toHaveTextContent("Costuma ser cache");
    expect(root).toHaveTextContent("3,0 GB");
    expect(root).toHaveTextContent("Coberto pelo dump do banco.");
    expect(within(root).getByLabelText(/PostgreSQL · serviço db/)).toBeChecked();
    expect(within(root).getByLabelText(/Redis · serviço cache/)).not.toBeChecked();
    expect(within(root).getByLabelText(/\/var\/lib\/postgresql\/data/)).toBeDisabled();
    expect(within(root).getByLabelText(/^\/app\/uploads/)).toBeChecked();
    expect(within(root).getByLabelText(/^\/app\/cache/)).not.toBeChecked();
    expect(screen.getByTestId("unsaved-writes")).toHaveTextContent("Serviço web: 2 arquivo(s), por exemplo /app/notas/1.pdf, /app/notas/2.pdf");
    expect(root).toHaveTextContent("Por enquanto os backups ficam só na VPS.");
    expect(root).toHaveTextContent("Seus backups cobrem os últimos 2 dias (cópias na VPS).");
  });

  it("marcar, desmarcar e adicionar pasta: salva tudo de uma vez", async () => {
    renderCard();
    const root = await screen.findByTestId("project-backups");
    const save = within(root).getByRole("button", { name: /Salvar itens/ });
    expect(save).toBeDisabled();
    fireEvent.click(within(root).getByLabelText(/Redis · serviço cache/));
    fireEvent.click(within(root).getByLabelText(/^\/app\/uploads/));
    fireEvent.change(within(root).getByLabelText("Serviço"), { target: { value: "web" } });
    fireEvent.change(within(root).getByLabelText("Caminho dentro do container"), { target: { value: "/app/notas" } });
    fireEvent.click(within(root).getByRole("button", { name: /Adicionar pasta/ }));
    expect(root).toHaveTextContent("/app/notas · serviço web");
    fireEvent.click(save);
    expect(await within(root).findByText(/Itens salvos/)).toBeInTheDocument();
    expect(calls.find((c) => c.key === "PUT /api/backups/targets/project:p1")?.body).toEqual({
      choices: { "db:cache": true, "mnt:web:/app/uploads": false },
      extraFolders: [{ service: "web", path: "/app/notas" }],
    });
    fireEvent.click(within(root).getByRole("button", { name: "Remover /app/notas" }));
    expect(root).not.toHaveTextContent("/app/notas · serviço web");
  });

  it("detectar de novo, fazer backup agora e abrir a restauração (com 'Publicar do GitHub')", async () => {
    renderCard();
    const root = await screen.findByTestId("project-backups");
    fireEvent.click(within(root).getByRole("button", { name: /Detectar de novo/ }));
    expect(await within(root).findByText("Detecção atualizada.")).toBeInTheDocument();
    fireEvent.click(within(root).getByRole("button", { name: /Fazer backup agora/ }));
    await waitFor(() => expect(root).toHaveTextContent("Concluído"));
    expect(root).toHaveTextContent("2026-10-14_09-00.7z");
    fireEvent.click(within(root).getByRole("button", { name: /Restaurar/ }));
    const dialog = await screen.findByTestId("restore-dialog");
    expect(await within(dialog).findByText("Ainda não há backups para restaurar.")).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/Publicar do GitHub antes de restaurar/)).not.toBeChecked();
  });

  it("Conferir um backup e Conferir todos do projeto; o fuso da agenda com o link para trocar", async () => {
    const b = { id: "r1", target: "project:p1", targetName: "Loja", operation: "backup" as const, trigger: "manual" as const, status: "success" as const, queuedAt: "2026-10-14T12:00:00Z", startedAt: null, finishedAt: "2026-10-14T12:01:00Z", fileName: "2026-10-14_09-00.7z", sizeBytes: 1000, local: true, remote: "verified" as const, remoteEncrypted: true, remoteDetail: null, steps: [], warnings: [], error: null, localExists: true, localCheck: null, remoteCheck: { status: "ok" as const, at: "2026-10-14T12:02:00Z", reason: null } };
    view.target.lastBackup = b;
    view.history = [b];
    renderCard();
    const root = await screen.findByTestId("project-backups");
    expect(within(root).getByTestId("backup-timezone")).toHaveTextContent("UTC-03:00");
    const row = within(root).getAllByTestId("backup-record")[0]!;
    expect(row).toHaveTextContent("Cópia externa: Íntegro — conferido em");
    fireEvent.click(within(row).getByRole("button", { name: "Conferir" }));
    await waitFor(() => expect(calls.find((c) => c.key === "POST /api/backups/targets/project:p1/verify")?.body).toEqual({ fileName: "2026-10-14_09-00.7z" }));
    expect(await within(root).findByText(/Conferindo… 0 de 0/)).toBeInTheDocument();
    fireEvent.click(within(root).getByRole("button", { name: "Conferir todos" }));
    await waitFor(() => expect(calls.filter((c) => c.key === "POST /api/backups/targets/project:p1/verify").at(-1)!.body).toEqual({}));
  });

  it("agenda em pausa depois de restaurar o painel: o motivo aparece na aba do projeto", async () => {
    view.target = { ...view.target, pausedReason: "Em pausa: o painel foi restaurado de outro servidor e os dados deste item ainda não voltaram." };
    renderCard();
    expect(await screen.findByTestId("project-paused")).toHaveTextContent("Em pausa: o painel foi restaurado de outro servidor");
  });

  it("seguindo o padrão do painel ou configuração própria, com Voltar ao padrão", async () => {
    const { unmount } = renderCard();
    const freq = await screen.findByTestId("project-settings-source");
    expect(freq).toHaveTextContent("Seguindo o padrão do painel");
    expect(freq).toHaveTextContent("Salvar aqui passa a usar uma configuração própria.");
    expect(within(freq).queryByRole("button", { name: "Voltar ao padrão" })).toBeNull();
    unmount();
    view.target = { ...view.target, followsDefaults: false, frequencyHours: 12 };
    renderCard();
    const own = await screen.findByTestId("project-settings-source");
    expect(own).toHaveTextContent("Configuração própria");
    fireEvent.click(within(own).getByRole("button", { name: "Voltar ao padrão" }));
    await waitFor(() => expect(screen.getByTestId("project-settings-source")).toHaveTextContent("Seguindo o padrão do painel"));
    expect(calls.some((c) => c.key === "POST /api/backups/targets/project:p1/use-defaults")).toBe(true);
    expect(await screen.findByText("O projeto voltou ao padrão do painel.")).toBeInTheDocument();
  });

  it("antes do primeiro deploy: explica e oferece detectar agora", async () => {
    view.detection = null;
    renderCard();
    expect(await screen.findByText(/Ainda não detectado/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Salvar itens/ })).not.toBeInTheDocument();
  });
});

describe("aba Backups do projeto — e-mail", () => {
  function comEmail(target: Record<string, unknown> | null) {
    emailRes = { email: { enabled: true } };
    STATUS = { ...BASE_STATUS, targets: target ? [emailTarget(target)] : [] } as unknown as BackupsStatus;
  }

  it("e-mail desligado no projeto: nenhuma nota sobre e-mail", async () => {
    renderCard();
    await screen.findByTestId("project-backups");
    expect(screen.queryByTestId("project-email-backup")).not.toBeInTheDocument();
  });

  it("e-mail ligado: nota com o link para Configurações → Backups e o estado do backup do e-mail", async () => {
    comEmail({ lastSuccessAt: "2026-10-14T12:00:00Z", frequencyHours: 24, lastRemoteVerifiedAt: "2026-10-14T13:00:00Z" });
    renderCard();
    const note = await screen.findByTestId("project-email-backup");
    expect(within(note).getByRole("heading", { name: "Backup do e-mail" })).toBeInTheDocument();
    expect(within(note).getByTestId("project-email-backup-badge")).toHaveTextContent("Ativo — todas as caixas do servidor, inclusive as deste projeto");
    expect(note).toHaveTextContent("do servidor de e-mail inteiro (as caixas de todos os projetos), não por projeto");
    expect(note).toHaveTextContent("O e-mail deste projeto é protegido pelo backup do servidor de e-mail (todas as caixas juntas)");
    expect(note).toHaveTextContent("Desativar o backup deste projeto não desativa o do e-mail.");
    expect(within(note).getByRole("link", { name: /Configurações → Backups → E-mail/ })).toHaveAttribute("href", "/settings/backups");
    expect(within(note).getByRole("link", { name: "Abrir configuração do e-mail" })).toHaveAttribute("href", "/settings/backups");
    const det = within(note).getByTestId("project-email-backup-details");
    expect(det).toHaveTextContent("Frequência: a cada 24 h");
    expect(det).toHaveTextContent("Último backup:");
    expect(det).toHaveTextContent("Conferido no armazenamento externo em");
    expect(within(note).queryByTestId("project-email-backup-off")).not.toBeInTheDocument();
  });

  it("e-mail ligado, backup do e-mail ainda sem nenhuma cópia nem conferência: diz isso", async () => {
    comEmail({ lastSuccessAt: null });
    renderCard();
    const det = await screen.findByTestId("project-email-backup-details");
    expect(det).toHaveTextContent("Ainda sem backup concluído.");
    expect(det).toHaveTextContent("Ainda sem conferência no armazenamento externo.");
  });

  it("duas seções distintas, cada uma com título e selo; backup do projeto desativado com o do e-mail ativo", async () => {
    view.target = { ...view.target, enabled: false };
    comEmail({ lastSuccessAt: "2026-10-14T12:00:00Z" });
    renderCard();
    const email = await screen.findByTestId("project-email-backup");
    const proj = screen.getByTestId("project-backup-section");
    expect(within(proj).getByRole("heading", { name: "Backup do projeto" })).toBeInTheDocument();
    expect(within(proj).getByTestId("project-backup-badge")).toHaveTextContent("Desligado");
    expect(proj).toHaveTextContent("Desativar o backup deste projeto NÃO desativa o backup do e-mail.");
    expect(within(email).getByTestId("project-email-backup-badge")).toHaveTextContent("Ativo");
    expect(within(email).queryByTestId("project-email-backup-off")).not.toBeInTheDocument();
  });

  it("projeto sem e-mail: só a seção do projeto, sem a frase do e-mail", async () => {
    renderCard();
    const proj = await screen.findByTestId("project-backup-section");
    expect(within(proj).getByTestId("project-backup-badge")).toHaveTextContent("Ativo");
    expect(proj).not.toHaveTextContent("e-mail");
    expect(screen.queryByTestId("project-email-backup")).not.toBeInTheDocument();
  });

  it("Fazer backup do e-mail agora enfileira o alvo email", async () => {
    comEmail({});
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Fazer backup do e-mail agora" }));
    await waitFor(() => expect(calls.some((c) => c.key === "POST /api/backups/targets/email/run")).toBe(true));
    expect(await screen.findByText(/Backup do e-mail na fila/)).toBeInTheDocument();
  });

  it("em inglês: títulos, selos e botões", async () => {
    setLocale("en");
    comEmail({ lastSuccessAt: null });
    renderCard();
    const email = await screen.findByTestId("project-email-backup");
    expect(within(email).getByRole("heading", { name: "Email backup" })).toBeInTheDocument();
    expect(within(email).getByTestId("project-email-backup-badge")).toHaveTextContent("On — all mailboxes on the server, including this project's");
    expect(within(email).getByRole("link", { name: "Open email backup settings" })).toBeInTheDocument();
    expect(within(email).getByRole("button", { name: "Back up email now" })).toBeInTheDocument();
    expect(within(screen.getByTestId("project-backup-section")).getByRole("heading", { name: "Project backup" })).toBeInTheDocument();
    expect(screen.getByTestId("project-backup-section")).toHaveTextContent("Turning off this project's backup does NOT turn off the email backup.");
  });

  it("backup do e-mail desligado: aviso âmbar com o link para ligar", async () => {
    comEmail({ enabled: false });
    renderCard();
    const off = await screen.findByTestId("project-email-backup-off");
    expect(off).toHaveTextContent("O backup do e-mail está desligado: as caixas deste projeto não estão sendo copiadas.");
    expect(within(off).getByRole("link", { name: /Ligar em Configurações → Backups → E-mail/ })).toHaveAttribute("href", "/settings/backups");
  });

  it("sem o dado do alvo e-mail na lista: só a nota, sem estado inventado", async () => {
    comEmail(null);
    renderCard();
    const note = await screen.findByTestId("project-email-backup");
    expect(note).not.toHaveTextContent("Backup do e-mail:");
    expect(screen.queryByTestId("project-email-backup-off")).not.toBeInTheDocument();
  });

  it("falha ao consultar o e-mail do projeto: a aba funciona sem a nota", async () => {
    emailRes = undefined;
    renderCard();
    await screen.findByTestId("project-backups");
    expect(screen.queryByTestId("project-email-backup")).not.toBeInTheDocument();
  });

  it("projeto sem banco nem arquivos: o estado vazio explica; com e-mail diz que só resta o e-mail", async () => {
    view.detection = { ...view.detection!, databases: [], mounts: [], unsavedWrites: [] };
    const { unmount } = renderCard();
    expect(await screen.findByTestId("project-nothing-to-copy")).toHaveTextContent("Este projeto não tem banco de dados nem arquivos para copiar.");
    expect(screen.getByTestId("project-nothing-to-copy")).not.toHaveTextContent("além do e-mail");
    unmount();
    comEmail({});
    renderCard();
    expect(await screen.findByTestId("project-nothing-to-copy")).toHaveTextContent("Não há nada para copiar além do e-mail");
  });

  it("com banco detectado, não mostra o estado vazio", async () => {
    renderCard();
    await screen.findByTestId("project-backups");
    expect(screen.queryByTestId("project-nothing-to-copy")).not.toBeInTheDocument();
  });
});
