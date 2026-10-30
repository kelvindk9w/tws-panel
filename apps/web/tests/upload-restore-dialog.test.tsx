/**
 * upload-restore-dialog.test.tsx — "Restaurar de um arquivo": conferência prévia, envio com progresso e cancelar,
 * pedido de senha do backup do painel, confirmação, reautenticação e acompanhamento até o fim.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UploadRestoreJob, UploadRestoreOptions, UploadRestoreUploaded } from "@paas/core";
import { setLocale } from "@/i18n/core";

const apiFetchMock = vi.hoisted(() => vi.fn());
const putRawMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});
vi.mock("@/lib/upload-restore", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/upload-restore")>();
  return { ...real, putRaw: putRawMock };
});

import { ApiRequestError } from "@/lib/api";
import { UploadAborted } from "@/lib/upload-restore";
import { UploadRestoreDialog } from "@/components/backups/UploadRestoreDialog";
import { ProjectBackupsCard } from "@/components/project/ProjectBackupsCard";

const BASE = "/api/backups/projects/p1/upload-restore";
let options: UploadRestoreOptions;
let calls: Array<{ url: string; init?: RequestInit }>;
let precheck: unknown;
let jobs: UploadRestoreJob[];
let startError: Error | null;
let checkError: Error | null;

function job(over: Partial<UploadRestoreJob> = {}): UploadRestoreJob {
  return {
    id: "j1",
    projectId: "p1",
    service: "db",
    engine: "postgres",
    format: "sql",
    sizeBytes: 10,
    clean: false,
    backup: "full",
    status: "restoring",
    startedAt: "2026-10-14T12:00:00Z",
    finishedAt: null,
    backupFileName: null,
    output: null,
    error: null,
    ...over,
  };
}

function uploaded(over: Partial<UploadRestoreUploaded> = {}): UploadRestoreUploaded {
  return { uploadId: "u1", sizeBytes: 2048, format: "sql", gzip: false, needsPassword: false, ...over };
}

function install(over: Partial<UploadRestoreOptions> = {}) {
  options = {
    services: [{ service: "db", engine: "postgres", running: true, databases: ["loja", "outro"], defaultDatabase: "loja" }],
    maxBytes: 10 * 1024 ** 3,
    freeBytes: 50 * 1024 ** 3,
    development: false,
    busy: false,
    ...over,
  };
}

beforeEach(() => {
  setLocale("pt-BR");
  install();
  calls = [];
  precheck = { format: "sql", gzip: false };
  jobs = [];
  startError = null;
  checkError = null;
  putRawMock.mockReset();
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const method = init?.method ?? "GET";
    if (url === BASE && method === "GET") return options;
    if (url.startsWith(`${BASE}/precheck`)) {
      if (precheck instanceof Error) throw precheck;
      return precheck;
    }
    if (url.endsWith("/check")) {
      if (checkError) throw checkError;
      return { ok: true, databases: ["loja"] };
    }
    if (url === BASE && method === "POST") {
      if (startError) throw startError;
      return job({ status: "validating" });
    }
    if (url.includes("/jobs/")) return jobs.shift() ?? job({ status: "success", output: "ok output" });
    return {};
  });
});
afterEach(() => cleanup());

function dialog(props: Partial<React.ComponentProps<typeof UploadRestoreDialog>> = {}) {
  const onClose = vi.fn();
  const onFinished = vi.fn();
  render(<UploadRestoreDialog projectId="p1" projectName="Loja" onClose={onClose} onFinished={onFinished} pollMs={5} {...props} />);
  return { onClose, onFinished };
}

async function pick(name = "dump.sql", size = 100) {
  const input = (await screen.findByLabelText("Arquivo do dump")) as HTMLInputElement;
  const file = new File([new Uint8Array(size)], name);
  fireEvent.change(input, { target: { files: [file] } });
  return file;
}

/** Faz o envio terminar na hora. */
function uploadOk(result: UploadRestoreUploaded) {
  putRawMock.mockImplementation((_u: string, body: Blob, onProgress: (l: number, t: number) => void) => {
    onProgress(body.size / 2, body.size);
    onProgress(body.size, body.size);
    return { promise: Promise.resolve(result), abort: vi.fn() };
  });
}

async function sendButton() {
  const send = await screen.findByRole("button", { name: /Enviar arquivo/ });
  await waitFor(() => expect(send).not.toBeDisabled());
  return send;
}

async function toReady(result = uploaded()) {
  uploadOk(result);
  await pick();
  fireEvent.click(await sendButton());
  await screen.findByTestId("upload-ready");
}

function fillAuth(word = "Loja") {
  fireEvent.change(screen.getByLabelText("Senha do painel"), { target: { value: "senha" } });
  fireEvent.change(screen.getByLabelText(/Código do app/), { target: { value: "123456" } });
  fireEvent.change(document.getElementById("ur-confirm") as HTMLInputElement, { target: { value: word } });
}

describe("UploadRestoreDialog: formulário", () => {
  it("carrega as opções, confere o arquivo e habilita o envio", async () => {
    dialog();
    await pick();
    await screen.findByRole("status");
    expect(calls.some((c) => c.url.startsWith(`${BASE}/precheck?service=db&name=dump.sql`))).toBe(true);
    await sendButton();
  });

  it("recusa .zip e arquivo grande demais sem consultar o servidor", async () => {
    install({ maxBytes: 1024 * 1024 });
    dialog();
    await pick("x.zip");
    expect(await screen.findByRole("alert")).toBeTruthy();
    await pick("grande.sql", 2 * 1024 * 1024);
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(calls.some((c) => c.url.includes("/precheck"))).toBe(false);
  });

  it("mostra o motivo quando a conferência prévia recusa", async () => {
    precheck = new ApiRequestError(400, "wrong_engine", "x");
    dialog();
    await pick();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Enviar arquivo/ })).toBeDisabled();
  });

  it("avisa quando não há banco, quando está ocupado e quando o serviço está parado", async () => {
    install({ services: [] });
    dialog();
    await screen.findByText(/não tem um banco/i);
    cleanup();
    install({ busy: true, freeBytes: null });
    dialog();
    await screen.findByText(/andamento/i);
    cleanup();
    install({ services: [{ service: "db", engine: "mysql", running: false, databases: [], defaultDatabase: null }] });
    dialog();
    await screen.findByLabelText("Arquivo do dump");
    expect(document.getElementById("ur-database")?.tagName).toBe("INPUT");
    expect(screen.getByRole("button", { name: /Enviar arquivo/ })).toBeDisabled();
  });

  it("mostra erro ao carregar as opções e troca de serviço", async () => {
    apiFetchMock.mockRejectedValueOnce(new Error("falhou"));
    dialog();
    await screen.findByText("falhou");
    cleanup();
    install({
      services: [
        { service: "db", engine: "postgres", running: true, databases: ["loja"], defaultDatabase: "loja" },
        { service: "mongo", engine: "mongo", running: true, databases: [], defaultDatabase: null },
      ],
    });
    dialog();
    const sel = await screen.findByLabelText("Banco de destino (serviço)");
    fireEvent.change(sel, { target: { value: "mongo" } });
    expect(document.getElementById("ur-database")).toBeNull();
  });

  it("Cancelar fecha o diálogo", async () => {
    const { onClose } = dialog();
    await screen.findByLabelText("Arquivo do dump");
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("UploadRestoreDialog: envio", () => {
  it("cancelar o envio volta ao formulário com aviso", async () => {
    let rejectIt: (e: unknown) => void = () => undefined;
    const abort = vi.fn(() => rejectIt(new UploadAborted()));
    putRawMock.mockImplementation((_u: string, body: Blob, onProgress: (l: number, t: number) => void) => {
      onProgress(10, body.size);
      return { promise: new Promise((_r, rej) => (rejectIt = rej)), abort };
    });
    dialog();
    await pick();
    fireEvent.click(await sendButton());
    await screen.findByRole("progressbar");
    fireEvent.click(screen.getByTestId("upload-cancel"));
    expect(abort).toHaveBeenCalled();
    await screen.findByLabelText("Arquivo do dump");
  });

  it("erro no envio mostra a mensagem", async () => {
    putRawMock.mockImplementation(() => ({ promise: Promise.reject(new ApiRequestError(413, "too_large", "grande")), abort: vi.fn() }));
    dialog();
    await pick();
    fireEvent.click(await sendButton());
    expect(await screen.findByRole("alert")).toBeTruthy();
  });

  it("desmontar durante o envio cancela", async () => {
    const abort = vi.fn();
    putRawMock.mockImplementation(() => ({ promise: new Promise(() => undefined), abort }));
    const { unmount } = render(<UploadRestoreDialog projectId="p1" projectName="Loja" onClose={vi.fn()} />);
    await pick();
    fireEvent.click(await sendButton());
    await screen.findByRole("progressbar");
    unmount();
    expect(abort).toHaveBeenCalled();
  });
});

describe("UploadRestoreDialog: restaurar", () => {
  it("exige nome, senha e código e acompanha até o fim", async () => {
    const { onFinished } = dialog();
    await toReady();
    const go = screen.getByTestId("upload-start");
    expect(go).toBeDisabled();
    fillAuth();
    await waitFor(() => expect(go).not.toBeDisabled());
    jobs = [job({ status: "waiting_backup" }), job({ status: "restoring", backupFileName: "b.7z" }), job({ status: "success", output: "ok output" })];
    fireEvent.click(go);
    await screen.findByTestId("upload-job");
    await waitFor(() => expect(screen.getByTestId("upload-output").textContent).toBe("ok output"), { timeout: 3000 });
    expect(onFinished).toHaveBeenCalledTimes(1);
    const post = calls.find((c) => c.url === BASE && c.init?.method === "POST");
    const body = JSON.parse(String(post?.init?.body));
    expect(body).toMatchObject({ uploadId: "u1", service: "db", database: "loja", clean: false, backup: "full", confirm: "Loja", currentPassword: "senha", code: "123456" });
  });

  it("projeto de desenvolvimento começa sem backup e o dump custom oferece limpar", async () => {
    install({ development: true });
    dialog();
    await toReady(uploaded({ format: "pg_custom" }));
    expect((screen.getByTestId("upload-backup-none") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByTestId("upload-clean"));
    fillAuth();
    fireEvent.click(screen.getByTestId("upload-start"));
    await screen.findByTestId("upload-job");
    const post = calls.find((c) => c.url === BASE && c.init?.method === "POST");
    expect(JSON.parse(String(post?.init?.body))).toMatchObject({ clean: true, backup: "none" });
  });

  it("falha ao começar mostra o erro e falha do trabalho mostra a saída", async () => {
    startError = new ApiRequestError(401, "reauth_failed", "Senha incorreta");
    dialog();
    await toReady();
    fillAuth();
    fireEvent.click(screen.getByTestId("upload-start"));
    expect((await screen.findByRole("alert")).textContent).toContain("Senha incorreta");
    startError = null;
    jobs = [job({ status: "failed", output: "boom", error: { code: "restore_failed", message: "Falhou" } })];
    fireEvent.click(screen.getByTestId("upload-start"));
    await screen.findByText("Falhou", {}, { timeout: 3000 });
    expect(screen.getByTestId("upload-output").textContent).toBe("boom");
  });

  it("backup do painel cifrado pede a senha e confere", async () => {
    dialog();
    await toReady(uploaded({ format: "panel_backup", needsPassword: true }));
    const go = screen.getByTestId("upload-start");
    fillAuth();
    expect(go).toBeDisabled();
    fireEvent.change(document.getElementById("ur-backup-password") as HTMLInputElement, { target: { value: "segredo" } });
    fireEvent.click(screen.getByTestId("upload-panel-check"));
    await waitFor(() => expect(go).not.toBeDisabled());
  });

  it("erro ao conferir a senha do backup aparece", async () => {
    checkError = new ApiRequestError(400, "invalid_backup", "Senha errada");
    dialog();
    await toReady(uploaded({ format: "panel_backup", needsPassword: true }));
    fireEvent.change(document.getElementById("ur-backup-password") as HTMLInputElement, { target: { value: "x" } });
    fireEvent.click(screen.getByTestId("upload-panel-check"));
    expect((await screen.findByRole("alert")).textContent).toContain("Senha errada");
  });

  it("descartar apaga o arquivo e fecha", async () => {
    const { onClose } = dialog();
    await toReady();
    fireEvent.click(screen.getByTestId("upload-discard"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.some((c) => c.url === `${BASE}/files/u1` && c.init?.method === "DELETE")).toBe(true);
  });

  it("desiste de acompanhar depois de muitas falhas seguidas", async () => {
    const { onClose } = dialog({ pollMs: 1 });
    await toReady();
    fillAuth();
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === BASE && init?.method === "POST") return job({ status: "restoring" });
      throw new Error("rede");
    });
    fireEvent.click(screen.getByTestId("upload-start"));
    await screen.findByTestId("upload-lost", {}, { timeout: 8000 });
    fireEvent.click(screen.getByTestId("upload-close"));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("botão na aba Backups", () => {
  it("abre o diálogo", async () => {
    const view = {
      target: { id: "project:p1", kind: "project", name: "Loja", folder: "loja", enabled: true, frequencyHours: 24, localKeep: 2, remoteKeep: 5, lastBackup: null, lastSuccessAt: null, lastRemoteVerifiedAt: null, nextRunAt: null, available: true, followsDefaults: true },
      detection: { detectedAt: null, databases: [], mounts: [], unsavedWrites: [], sourceFolder: null, error: null },
      choices: {},
      extraFolders: [],
      history: [],
      destinationConnected: false,
      restoreCheck: { settings: null, last: null, unavailableReason: null, unavailableCode: null, engine: null, candidates: [], noCandidatesCode: null, notice: null },
    };
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === BASE) return options;
      if (url.includes("/email")) return { email: { enabled: false } };
      if (url.startsWith("/api/backups/status")) return { timezone: "UTC", backupHour: 3, archiverAvailable: true };
      return view;
    });
    render(
      <MemoryRouter>
        <ProjectBackupsCard projectId="p1" projectName="Loja" />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByTestId("upload-restore-open"));
    await screen.findByTestId("upload-restore-dialog");
  });
});
