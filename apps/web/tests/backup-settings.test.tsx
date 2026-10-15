/**
 * backup-settings.test.tsx — Configurações → Backups com a API simulada (com
 * estado): conectar o R2 → criar a senha (sugestão, força, kit, "Guardei")
 * → ver a senha com a senha de login → testar a senha → fazer backup agora →
 * restaurar o painel (confirmação digitada e progresso) → restaurar de outro
 * servidor. Também: 7-Zip ausente, lembrete trimestral, desligar a
 * criptografia e o histórico com o motivo da falha.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackupCatalog, BackupRecord, BackupsStatus, BackupTargetStatus } from "@paas/core";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { ApiRequestError } from "@/lib/api";
import { BackupSettings } from "@/pages/settings/BackupSettings";

const SENHA = "girafa-lunar-pomar-tijolo-vento-cedro-512";

function target(id: string, kind: BackupTargetStatus["kind"], name: string, partial: Partial<BackupTargetStatus> = {}): BackupTargetStatus {
  return {
    id,
    kind,
    name,
    folder: id,
    enabled: true,
    frequencyHours: 24,
    localKeep: 2,
    remoteKeep: 5,
    lastBackup: null,
    lastSuccessAt: null,
    lastRemoteVerifiedAt: null,
    nextRunAt: "2026-10-15T06:00:00Z",
    available: true,
    ...partial,
  };
}

function record(partial: Partial<BackupRecord> = {}): BackupRecord {
  return {
    id: "r1",
    target: "panel",
    targetName: "Painel",
    operation: "backup",
    trigger: "manual",
    status: "success",
    queuedAt: "2026-10-14T12:00:00Z",
    startedAt: "2026-10-14T12:00:00Z",
    finishedAt: "2026-10-14T12:01:00Z",
    fileName: "2026-10-14_09-00.7z",
    sizeBytes: 2048,
    local: true,
    remote: "verified",
    remoteEncrypted: true,
    remoteDetail: null,
    steps: [],
    warnings: [],
    error: null,
    ...partial,
  };
}

let state: BackupsStatus;
let calls: Array<{ key: string; body: Record<string, unknown> }>;
let failures: Record<string, ApiRequestError>;
let restorePolls: number;

function base(): BackupsStatus {
  return {
    destination: null,
    encryption: { enabled: true, passwordSet: false, passwordSetAt: null, acknowledgedAt: null, lastTestAt: null, lastTestOk: null },
    targets: [target("panel", "panel", "Painel"), target("email", "email", "E-mail", { available: false }), target("project:p1", "project", "Loja")],
    running: null,
    queued: [],
    history: [],
    timezone: "UTC-03:00",
    backupHour: 3,
    archiverAvailable: true,
    localPath: "/var/lib/docker/volumes/paas_data/_data/backups",
  };
}

const CATALOG: BackupCatalog = {
  panel: [{ fileName: "2026-10-13_03-00.7z", at: "2026-10-13T06:00:00Z", sizeBytes: 4096, local: false, remote: true }],
  email: [],
  projects: [
    { folder: "loja", projectId: "p1", projectName: "Loja", points: [{ fileName: "2026-10-13_03-00.7z", at: "2026-10-13T06:00:00Z", sizeBytes: 9000, local: false, remote: true }] },
    { folder: "blog", projectId: null, projectName: null, points: [] },
  ],
};

function handler(path: string, init?: RequestInit): unknown {
  const method = init?.method ?? "GET";
  const key = `${method} ${path}`;
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  calls.push({ key, body });
  if (failures[key]) throw failures[key];
  switch (key) {
    case "GET /api/backups":
      return state;
    case "PUT /api/backups/destination":
      state = {
        ...state,
        destination: {
          type: "s3",
          provider: body.provider as "r2",
          endpoint: String(body.endpoint),
          region: String(body.region),
          bucket: String(body.bucket),
          accessKeyHint: "…1234",
          connectedAt: "2026-10-14T12:00:00Z",
          testedAt: "2026-10-14T12:00:00Z",
        },
      };
      return state;
    case "POST /api/backups/destination/test":
      return state;
    case "DELETE /api/backups/destination":
      state = { ...state, destination: null };
      return state;
    case "GET /api/backups/password/suggest":
      return { password: SENHA };
    case "PUT /api/backups/password":
      state = { ...state, encryption: { ...state.encryption, passwordSet: true, passwordSetAt: new Date().toISOString(), acknowledgedAt: new Date().toISOString() } };
      return state;
    case "POST /api/backups/password/reveal":
      if (body.loginPassword !== "senha-login") throw new ApiRequestError(401, "invalid_login_password", "Senha de login incorreta.");
      return { password: SENHA };
    case "POST /api/backups/password/test":
      return body.password === SENHA ? { ok: true, message: "Senha certa." } : { ok: false, message: "Essa senha não abre os backups atuais." };
    case "PUT /api/backups/encryption":
      state = { ...state, encryption: { ...state.encryption, enabled: Boolean(body.enabled) } };
      return state;
    case "POST /api/backups/targets/panel/run": {
      const r = record({ id: "run1", status: "queued", finishedAt: null });
      state = { ...state, running: r, history: [r] };
      return r;
    }
    case "PUT /api/backups/targets/panel":
      state = { ...state, targets: state.targets.map((t) => (t.id === "panel" ? { ...t, ...(body as Partial<BackupTargetStatus>) } : t)) };
      return undefined;
    case "GET /api/backups/targets/panel/points":
      return { points: [{ fileName: "2026-10-14_03-00.7z", at: "2026-10-14T06:00:00Z", sizeBytes: 4096, local: true, remote: true }] };
    case "POST /api/backups/targets/panel/restore":
    case "POST /api/backups/targets/project:p1/restore":
      return record({ id: "rest1", operation: "restore", status: "running", steps: [{ label: "Conferir e abrir o arquivo", status: "running" }] });
    case "GET /api/backups/records/rest1":
      restorePolls++;
      return record({
        id: "rest1",
        operation: "restore",
        status: "success",
        steps: [{ label: "Conferir e abrir o arquivo", status: "done" }, { label: "Preparar a troca do estado do painel", status: "done" }],
        warnings: ["O painel vai reiniciar para terminar a restauração."],
      });
    case "GET /api/backups/catalog":
      return CATALOG;
    default:
      throw new Error(`rota inesperada: ${key}`);
  }
}

beforeEach(() => {
  state = base();
  calls = [];
  failures = {};
  restorePolls = 0;
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => handler(path, init));
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:kit"), revokeObjectURL: vi.fn() }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderPage() {
  return render(
    <MemoryRouter>
      <BackupSettings />
    </MemoryRouter>,
  );
}

describe("Configurações → Backups", () => {
  it("conecta o Cloudflare R2: testa e salva; a chave secreta não volta para a tela", async () => {
    renderPage();
    const card = await screen.findByTestId("destination-card");
    expect(within(card).getByText(/Create bucket/)).toBeInTheDocument();
    fireEvent.change(within(card).getByLabelText("Endpoint"), { target: { value: "https://abc.r2.cloudflarestorage.com" } });
    fireEvent.change(within(card).getByLabelText("Bucket"), { target: { value: "tws-backups" } });
    fireEvent.change(within(card).getByLabelText("Access Key ID"), { target: { value: "AKIA1234" } });
    fireEvent.change(within(card).getByLabelText("Secret Access Key"), { target: { value: "segredo-do-r2" } });
    fireEvent.click(within(card).getByRole("button", { name: /Testar e salvar/ }));
    expect(await within(card).findByText(/Conexão testada e salva/)).toBeInTheDocument();
    expect(calls.find((c) => c.key === "PUT /api/backups/destination")?.body).toMatchObject({
      provider: "r2",
      region: "auto",
      bucket: "tws-backups",
      secretAccessKey: "segredo-do-r2",
    });
    expect(card).toHaveTextContent(/bucket tws-backups/);
    expect(card).not.toHaveTextContent("segredo-do-r2");
    fireEvent.click(within(card).getByRole("button", { name: /Testar conexão/ }));
    expect(await within(card).findByText(/Conexão funcionando/)).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "Desconectar" }));
    fireEvent.click(within(card).getByRole("button", { name: "Sim, desconectar" }));
    await waitFor(() => expect(within(card).getByLabelText("Endpoint")).toBeInTheDocument());
  });

  it("erro do teste de conexão aparece e nada é salvo", async () => {
    failures["PUT /api/backups/destination"] = new ApiRequestError(502, "destination_test_failed", "Chave de acesso recusada pelo armazenamento.");
    renderPage();
    const card = await screen.findByTestId("destination-card");
    fireEvent.click(within(card).getByLabelText(/Outro compatível com S3/));
    fireEvent.change(within(card).getByLabelText("Endpoint"), { target: { value: "https://s3.exemplo.com" } });
    fireEvent.change(within(card).getByLabelText("Bucket"), { target: { value: "b1" } });
    fireEvent.change(within(card).getByLabelText("Access Key ID"), { target: { value: "AK" } });
    fireEvent.change(within(card).getByLabelText("Secret Access Key"), { target: { value: "x" } });
    fireEvent.click(within(card).getByRole("button", { name: /Testar e salvar/ }));
    expect(await within(card).findByRole("alert")).toHaveTextContent("Chave de acesso recusada");
  });

  it("cria a senha: alerta, sugestão forte, força, kit de recuperação e 'Guardei' obrigatório", async () => {
    renderPage();
    const setup = await screen.findByTestId("password-setup");
    expect(setup).toHaveTextContent("Sem esta senha, ninguém, nem a TWS, consegue abrir seus backups.");
    const save = within(setup).getByRole("button", { name: /Ativar a criptografia/ });
    fireEvent.change(within(setup).getByLabelText(/Senha dos backups/), { target: { value: "curta" } });
    expect(within(setup).getByTestId("password-strength")).toHaveTextContent("Curta demais");
    fireEvent.click(within(setup).getByRole("button", { name: /Sugerir uma frase forte/ }));
    await waitFor(() => expect(within(setup).getByLabelText(/Senha dos backups/)).toHaveValue(SENHA));
    expect(within(setup).getByTestId("password-strength")).toHaveTextContent(/Boa|Forte/);
    expect(save).toBeDisabled();
    fireEvent.click(within(setup).getByRole("button", { name: /Baixar kit de recuperação/ }));
    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(within(setup).getByText(/Kit baixado/)).toBeInTheDocument();
    fireEvent.click(within(setup).getByLabelText("Guardei a senha em lugar seguro"));
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(screen.queryByTestId("password-setup")).not.toBeInTheDocument());
    expect(calls.find((c) => c.key === "PUT /api/backups/password")?.body).toEqual({ password: SENHA, acknowledged: true });
  });

  it("com senha: ver a senha pede a senha de login; testar; trocar avisa sobre os backups antigos", async () => {
    state.destination = { type: "s3", provider: "r2", endpoint: "https://abc.r2.cloudflarestorage.com", region: "auto", bucket: "b", accessKeyHint: "…1234", connectedAt: "2026-10-14T12:00:00Z", testedAt: null };
    state.encryption = { ...state.encryption, passwordSet: true, passwordSetAt: new Date().toISOString() };
    renderPage();
    const card = await screen.findByTestId("encryption-card");
    fireEvent.click(within(card).getByRole("button", { name: /Ver a senha/ }));
    fireEvent.change(within(card).getByLabelText(/Confirme a sua senha de login/), { target: { value: "errada" } });
    fireEvent.click(within(card).getByRole("button", { name: "Ver a senha" }));
    expect(await within(card).findByText("Senha de login incorreta.")).toBeInTheDocument();
    fireEvent.change(within(card).getByLabelText(/Confirme a sua senha de login/), { target: { value: "senha-login" } });
    fireEvent.click(within(card).getByRole("button", { name: "Ver a senha" }));
    expect(await within(card).findByTestId("revealed-password")).toHaveTextContent(SENHA);
    fireEvent.click(within(card).getByRole("button", { name: "Esconder" }));
    expect(card).not.toHaveTextContent(SENHA);

    fireEvent.change(within(card).getByLabelText("Testar minha senha"), { target: { value: "outra-coisa-qualquer" } });
    fireEvent.click(within(card).getByRole("button", { name: "Testar" }));
    expect(await within(card).findByText(/não abre os backups atuais/)).toBeInTheDocument();

    fireEvent.click(within(card).getByRole("button", { name: "Trocar a senha" }));
    expect(within(card).getByTestId("password-setup")).toHaveTextContent(/Os antigos continuam abrindo só com a senha antiga/);
    fireEvent.click(within(card).getByRole("button", { name: "Cancelar" }));
    expect(within(card).queryByTestId("password-setup")).not.toBeInTheDocument();
  });

  it("desligar a criptografia pede confirmação e avisa que vai sem senha", async () => {
    renderPage();
    const card = await screen.findByTestId("encryption-card");
    fireEvent.click(within(card).getByRole("button", { name: "Desligar a criptografia" }));
    fireEvent.click(within(card).getByRole("button", { name: "Sim, desligar" }));
    expect(await within(card).findByText(/A cópia externa vai sem senha/)).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: /Ligar a criptografia/ }));
    expect(await within(card).findByTestId("password-setup")).toBeInTheDocument();
  });

  it("painel: frequência e cópias com a cobertura; Fazer backup agora mostra o andamento", async () => {
    state.destination = { type: "s3", provider: "r2", endpoint: "https://x", region: "auto", bucket: "b", accessKeyHint: "…1", connectedAt: "", testedAt: null };
    renderPage();
    const card = await screen.findByTestId("target-panel");
    expect(card).toHaveTextContent("Roda às 03:00 (horário da VPS, UTC-03:00)");
    expect(card).toHaveTextContent("Seus backups cobrem os últimos 5 dias no armazenamento externo e os últimos 2 dias na VPS.");
    fireEvent.change(within(card).getByLabelText("Frequência"), { target: { value: "6" } });
    expect(card).toHaveTextContent("e depois a cada 6 horas");
    expect(card).toHaveTextContent("Seus backups cobrem as últimas 30 horas no armazenamento externo e as últimas 12 horas na VPS.");
    fireEvent.click(within(card).getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(calls.find((c) => c.key === "PUT /api/backups/targets/panel")?.body).toMatchObject({ frequencyHours: 6 }));
    fireEvent.click(within(card).getByRole("button", { name: /Fazer backup agora/ }));
    expect(await screen.findByText(/Fazendo backup de Painel/)).toBeInTheDocument();
    const email = screen.getByTestId("target-email");
    expect(email).toHaveTextContent("O servidor de e-mail não está instalado nesta VPS.");
  });

  it("restaurar o painel: confirma digitando 'painel' e acompanha até o fim", async () => {
    renderPage();
    const card = await screen.findByTestId("target-panel");
    fireEvent.click(within(card).getByRole("button", { name: /Restaurar/ }));
    const dialog = await screen.findByTestId("restore-dialog");
    expect(dialog).toHaveTextContent(/O painel volta inteiro ao estado daquela data/);
    await within(dialog).findByText(/Na VPS/);
    const go = within(dialog).getByRole("button", { name: "Restaurar" });
    expect(go).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Para confirmar, digite/), { target: { value: "PAINEL" } });
    expect(go).toBeEnabled();
    fireEvent.click(go);
    await waitFor(() => expect(restorePolls).toBeGreaterThan(0), { timeout: 4000 });
    expect(await within(dialog).findByText("Concluído")).toBeInTheDocument();
    expect(dialog).toHaveTextContent("O painel vai reiniciar");
    expect(within(dialog).getByRole("button", { name: "Recarregar a página" })).toBeInTheDocument();
    expect(calls.find((c) => c.key === "POST /api/backups/targets/panel/restore")?.body).toMatchObject({ source: "local", confirm: "PAINEL" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Fechar" }));
    expect(screen.queryByTestId("restore-dialog")).not.toBeInTheDocument();
  });

  it("restaurar de outro servidor: confere a senha antiga, lista e restaura na ordem", async () => {
    state.destination = { type: "s3", provider: "r2", endpoint: "https://x", region: "auto", bucket: "b", accessKeyHint: "…1", connectedAt: "", testedAt: null };
    renderPage();
    const card = await screen.findByTestId("other-server-card");
    fireEvent.click(within(card).getByRole("button", { name: "Começar" }));
    fireEvent.change(within(card).getByLabelText(/A mesma senha da VPS antiga/), { target: { value: "senha-antiga-errada" } });
    fireEvent.click(within(card).getByRole("button", { name: /Conferir e usar/ }));
    expect(await within(card).findByText(/Essa senha não abre os backups deste armazenamento/)).toBeInTheDocument();
    fireEvent.change(within(card).getByLabelText(/A mesma senha da VPS antiga/), { target: { value: SENHA } });
    fireEvent.click(within(card).getByRole("button", { name: /Conferir e usar/ }));
    expect(await within(card).findByText("Senha já definida neste painel.")).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: /Ver o que existe no armazenamento/ }));
    const catalog = await within(card).findByTestId("catalog");
    expect(catalog).toHaveTextContent("Não cadastrado aqui: restaure o painel primeiro.");
    fireEvent.click(within(catalog).getByRole("button", { name: "Restaurar" }));
    const dialog = await screen.findByTestId("restore-dialog");
    expect(within(dialog).getByLabelText(/Publicar do GitHub antes de restaurar/)).toBeChecked();
    expect(within(dialog).getByText(/Externo/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(/Para confirmar, digite/), { target: { value: "loja" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Restaurar" }));
    await waitFor(() =>
      expect(calls.find((c) => c.key === "POST /api/backups/targets/project:p1/restore")?.body).toMatchObject({ source: "remote", redeploy: true }),
    );
  });

  it("sem o arquivo de verificação: dá para usar a senha mesmo assim", async () => {
    state.destination = { type: "s3", provider: "r2", endpoint: "https://x", region: "auto", bucket: "b", accessKeyHint: "…1", connectedAt: "", testedAt: null };
    failures["POST /api/backups/password/test"] = new ApiRequestError(409, "no_check_file", "O armazenamento ainda não tem o arquivo de verificação da senha.");
    renderPage();
    const card = await screen.findByTestId("other-server-card");
    fireEvent.click(within(card).getByRole("button", { name: "Começar" }));
    fireEvent.change(within(card).getByLabelText(/A mesma senha da VPS antiga/), { target: { value: SENHA } });
    fireEvent.click(within(card).getByRole("button", { name: /Conferir e usar/ }));
    fireEvent.click(await within(card).findByRole("button", { name: "Usar esta senha mesmo assim" }));
    expect(await within(card).findByText("Senha já definida neste painel.")).toBeInTheDocument();
  });

  it("7-Zip ausente, lembrete da senha e histórico com o motivo da falha", async () => {
    state.archiverAvailable = false;
    state.destination = { type: "s3", provider: "r2", endpoint: "https://x", region: "auto", bucket: "b", accessKeyHint: "…1", connectedAt: "", testedAt: null };
    state.encryption = { ...state.encryption, passwordSet: true, passwordSetAt: "2026-01-01T00:00:00Z" };
    state.history = [
      record({ id: "f1", status: "failed", error: "Espaço em disco insuficiente: faltam 2,1 GB.", remote: "none" }),
      record({ id: "w1", status: "warning", remote: "failed", remoteDetail: "A cópia externa não passou na conferência: nada foi apagado." }),
    ];
    renderPage();
    expect(await screen.findByRole("alert", { name: "" })).toBeInTheDocument();
    expect(screen.getByText(/O 7-Zip não está instalado/)).toBeInTheDocument();
    expect(screen.getByTestId("reminder")).toHaveTextContent("Você ainda tem sua senha de backup? Teste aqui");
    const history = screen.getByTestId("backup-history");
    expect(history).toHaveTextContent("Espaço em disco insuficiente");
    expect(history).toHaveTextContent("nada foi apagado");
    expect(within(screen.getByTestId("target-panel")).getByRole("button", { name: /Fazer backup agora/ })).toBeDisabled();
    expect(screen.getByTestId("projects-card")).toHaveTextContent("Loja");
  });

  it("falha ao carregar: mensagem e Tentar de novo", async () => {
    failures["GET /api/backups"] = new ApiRequestError(500, "internal_error", "Não foi possível concluir agora.");
    renderPage();
    expect(await screen.findByText("Não foi possível concluir agora.")).toBeInTheDocument();
    delete failures["GET /api/backups"];
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(await screen.findByTestId("destination-card")).toBeInTheDocument();
  });
});
