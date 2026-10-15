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

const STATUS = { timezone: "UTC-03:00", backupHour: 3, archiverAvailable: true } as unknown as BackupsStatus;

beforeEach(() => {
  view = baseView();
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
      case "PUT /api/backups/targets/project:p1":
        view = { ...view, choices: { ...view.choices, ...(body.choices ?? {}) }, extraFolders: (body.extraFolders ?? view.extraFolders).map((f: { service: string; path: string }) => ({ id: `extra:${f.service}:${f.path}`, ...f })) };
        return undefined;
      case "POST /api/backups/projects/p1/detect":
        return view;
      case "POST /api/backups/targets/project:p1/run":
        view = {
          ...view,
          target: { ...view.target, lastBackup: { id: "r1", target: "project:p1", targetName: "Loja", operation: "backup", trigger: "manual", status: "success", queuedAt: "2026-10-14T12:00:00Z", startedAt: null, finishedAt: "2026-10-14T12:01:00Z", fileName: "2026-10-14_09-00.7z", sizeBytes: 1000, local: true, remote: "none", remoteEncrypted: false, remoteDetail: null, steps: [], warnings: [], error: null } },
        };
        view.history = [view.target.lastBackup!];
        return view.target.lastBackup;
      case "GET /api/backups/targets/project:p1/points":
        return { points: [] };
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

  it("antes do primeiro deploy: explica e oferece detectar agora", async () => {
    view.detection = null;
    renderCard();
    expect(await screen.findByText(/Ainda não detectado/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Salvar itens/ })).not.toBeInTheDocument();
  });
});
