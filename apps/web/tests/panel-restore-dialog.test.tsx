/**
 * panel-restore-dialog.test.tsx — a janela de restauração acompanha o
 * reinício do painel até o fim.
 *
 * Achado 22 da revisão: depois de preparar a troca, o painel reinicia. O
 * polling, em qualquer erro (sem conexão no reinício, 401 porque a sessão
 * não vale mais, 404 porque o histórico voltou do backup), recolocava o
 * mesmo registro e tentava de novo a cada 2 s, sem fim: a janela ficava
 * "em andamento" para sempre. Agora ela reconhece o reinício e mostra a
 * conclusão (ou a falha, quando dá para ler o histórico depois da volta).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackupRecord } from "@paas/core";

const apiFetchMock = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: (...args: unknown[]) => apiFetchMock(...args) };
});

import { ApiRequestError } from "@/lib/api";
import { RestoreDialog, type RestoreTarget } from "@/components/backups/backup-ui";

function record(partial: Partial<BackupRecord> = {}): BackupRecord {
  return {
    id: "rest1",
    target: "panel",
    targetName: "Painel",
    operation: "restore",
    trigger: "manual",
    status: "running",
    queuedAt: "2026-10-14T12:00:00Z",
    startedAt: "2026-10-14T12:00:00Z",
    finishedAt: null,
    fileName: "2026-10-14_09-00.7z",
    sizeBytes: null,
    local: true,
    remote: "none",
    remoteEncrypted: false,
    remoteDetail: null,
    steps: [{ label: "Conferir e abrir o arquivo", status: "running" }],
    warnings: [],
    error: null,
    ...partial,
  };
}

const WARNING = record({
  status: "warning",
  finishedAt: "2026-10-14T12:01:00Z",
  steps: [{ label: "Preparar a troca do estado do painel", status: "done" }],
  warnings: ["O painel vai reiniciar para terminar a restauração."],
});
const DOWN = new ApiRequestError(0, "network_error", "Não foi possível conectar ao servidor.");
const UNAUTH = new ApiRequestError(401, "unauthorized", "Sessão expirada.");
const GONE = new ApiRequestError(404, "not_found", "Registro não encontrado.");

const PANEL: RestoreTarget = { id: "panel", kind: "panel", name: "Painel" };
const PROJECT: RestoreTarget = { id: "project:p1", kind: "project", name: "Loja" };
const POINTS = [{ fileName: "2026-10-14_09-00.7z", at: "2026-10-14T06:00:00Z", sizeBytes: 4096, local: true, remote: false }];

/** Respostas do GET do registro, em ordem (a última se repete). */
let polls: Array<BackupRecord | ApiRequestError>;
let pollCount: number;
let history: BackupRecord[];

beforeEach(() => {
  pollCount = 0;
  history = [];
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${path}`;
    if (key.endsWith("/restore")) return record();
    if (key === "GET /api/backups/records/rest1") {
      const r = polls[Math.min(pollCount, polls.length - 1)]!;
      pollCount++;
      if (r instanceof ApiRequestError) throw r;
      return r;
    }
    if (key === "GET /api/backups") return { history };
    throw new Error(`rota inesperada: ${key}`);
  });
});
afterEach(() => cleanup());

function start(target: RestoreTarget, opts: { restartTimeoutMs?: number } = {}) {
  render(
    <RestoreDialog target={target} onClose={() => undefined} points={POINTS} pollMs={5} {...opts} />,
  );
  const dialog = screen.getByTestId("restore-dialog");
  fireEvent.change(within(dialog).getByLabelText(/Para confirmar, digite/), {
    target: { value: target.kind === "panel" ? "painel" : target.name },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Restaurar" }));
  return dialog;
}

describe("RestoreDialog — reinício do painel", () => {
  it("sem conexão no reinício e depois 401: mostra que o painel reiniciou e para de consultar", async () => {
    polls = [record(), DOWN, DOWN, UNAUTH];
    const dialog = start(PANEL);
    expect(await within(dialog).findByText(/O painel reiniciou com o estado do backup/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Recarregar a página" })).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent("Pode fechar esta janela: a restauração continua no servidor.");
    const n = pollCount;
    await new Promise((r) => setTimeout(r, 50));
    expect(pollCount).toBe(n);
  });

  it("registro some (404: o histórico voltou do backup): também é conclusão", async () => {
    polls = [record(), GONE];
    const dialog = start(PANEL);
    expect(await within(dialog).findByText(/O painel reiniciou com o estado do backup/)).toBeInTheDocument();
  });

  it("enquanto o painel está fora do ar, avisa que ele está reiniciando", async () => {
    polls = [WARNING, DOWN];
    const dialog = start(PANEL);
    expect(await within(dialog).findByText(/O painel está reiniciando/)).toBeInTheDocument();
  });

  it("aviso 'vai reiniciar' não encerra o acompanhamento: segue até o painel voltar", async () => {
    polls = [WARNING, WARNING, DOWN, UNAUTH];
    const dialog = start(PANEL);
    expect(await within(dialog).findByText(/O painel reiniciou com o estado do backup/)).toBeInTheDocument();
  });

  it("voltou com a sessão valendo e o histórico diz que a troca falhou e foi desfeita: mostra a falha", async () => {
    polls = [WARNING, DOWN, WARNING];
    history = [
      record({
        id: "boot1",
        status: "failed",
        finishedAt: "2026-10-14T12:02:00Z",
        steps: [{ label: "Trocar o estado do painel (na subida)", status: "failed" }],
        error: "EACCES: sem permissão em users.json",
      }),
    ];
    const dialog = start(PANEL);
    expect(await within(dialog).findByText(/A troca falhou na subida e foi desfeita/)).toBeInTheDocument();
    expect(dialog).toHaveTextContent("EACCES: sem permissão em users.json");
  });

  it("voltou com a sessão valendo e o histórico diz que a troca deu certo: mostra a conclusão", async () => {
    polls = [WARNING, DOWN, WARNING];
    history = [
      record({ id: "antigo", status: "failed", finishedAt: "2026-10-01T00:00:00Z", steps: [{ label: "Trocar o estado do painel (na subida)", status: "failed" }] }),
      record({
        id: "boot1",
        status: "success",
        finishedAt: "2026-10-14T12:02:00Z",
        steps: [{ label: "Trocar o estado do painel (na subida)", status: "done" }],
      }),
    ];
    const dialog = start(PANEL);
    expect(await within(dialog).findByText(/Painel restaurado: a troca terminou na subida/)).toBeInTheDocument();
  });

  it("voltou sem registro da subida no histórico: diz que voltou e manda conferir", async () => {
    polls = [WARNING, DOWN, WARNING];
    const dialog = start(PANEL);
    expect(await within(dialog).findByText(/O painel voltou/)).toBeInTheDocument();
  });

  it("voltou mas o histórico não pôde ser lido: diz que voltou e manda conferir", async () => {
    polls = [WARNING, DOWN, WARNING];
    const base = apiFetchMock.getMockImplementation()!;
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/backups") throw DOWN;
      return base(path, init);
    });
    const dialog = start(PANEL);
    expect(await within(dialog).findByText(/O painel voltou/)).toBeInTheDocument();
  });

  it("fora do ar além do limite: para e diz o que conferir", async () => {
    polls = [WARNING, DOWN];
    const dialog = start(PANEL, { restartTimeoutMs: 30 });
    expect(await within(dialog).findByText(/O painel não voltou/)).toBeInTheDocument();
  });
});

describe("RestoreDialog — outras restaurações", () => {
  it("projeto: sem resposta do servidor várias vezes seguidas, para de consultar e avisa", async () => {
    polls = [DOWN];
    const dialog = start(PROJECT);
    expect(await within(dialog).findByText(/Sem resposta do servidor/)).toBeInTheDocument();
    const n = pollCount;
    await new Promise((r) => setTimeout(r, 50));
    expect(pollCount).toBe(n);
  });

  it("projeto: um erro passageiro não interrompe — segue até o fim", async () => {
    polls = [DOWN, record({ target: "project:p1", status: "success", finishedAt: "2026-10-14T12:01:00Z" })];
    const dialog = start(PROJECT);
    await waitFor(() => expect(within(dialog).getByText("Concluído")).toBeInTheDocument());
  });
});
