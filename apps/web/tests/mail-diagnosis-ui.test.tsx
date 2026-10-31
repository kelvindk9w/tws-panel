/**
 * Tentativas recusadas, última tentativa do app, "por que nada chegou", avisos do projeto e teste de conexão.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAIL_REFUSAL_KINDS,
  type MailHintCode,
  type MailProbeResult,
  type MailRefusalItem,
  type MailRefusalsResponse,
  type ProjectMailDiagnosis,
} from "@paas/core";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { ApiRequestError } from "@/lib/api";
import { setLocale } from "@/i18n/core";
import { RefusalsSection } from "@/components/envios/RefusalsSection";
import { MailDiagnosisPanel } from "@/components/envios/MailDiagnosisPanel";
import { ProjectNotices } from "@/components/project/ProjectNotices";
import { MailProbe } from "@/components/project/MailProbe";

const refusal = (over: Partial<MailRefusalItem> = {}): MailRefusalItem => ({
  at: "2026-10-24T11:00:00Z",
  kind: "auth_failed",
  origin: "internal",
  login: "loja@example.com",
  projectId: "p1",
  projectName: "Loja",
  ...over,
});
const refusals = (items: MailRefusalItem[], over: Partial<MailRefusalsResponse> = {}): MailRefusalsResponse => ({
  items,
  total: items.length,
  retentionDays: 14,
  collectedAt: "2026-10-24T11:05:00Z",
  serverCreated: true,
  ...over,
});
const diag = (over: Partial<ProjectMailDiagnosis> = {}): ProjectMailDiagnosis => ({
  windowHours: 24,
  noSendsRecent: false,
  hints: [],
  notices: [],
  lastAttempt: null,
  ...over,
});

beforeEach(() => {
  apiFetchMock.mockReset();
  window.localStorage.clear();
});
afterEach(cleanup);

describe("RefusalsSection", () => {
  it("visão global: usa a rota global, mostra projeto e login e traduz cada motivo (pt-BR e en)", async () => {
    apiFetchMock.mockResolvedValue(refusals(MAIL_REFUSAL_KINDS.map((kind, i) => refusal({ kind, at: `2026-10-24T11:0${i}:00Z` }))));
    render(<RefusalsSection />);
    expect(await screen.findByText("Usuário ou senha errados")).toBeInTheDocument();
    expect(apiFetchMock.mock.calls[0]![0]).toBe("/api/mail/envios/recusas?limit=50");
    expect(screen.getByText("Mensagem grande demais")).toBeInTheDocument();
    expect(screen.getByText("Bloqueio temporário por muitas tentativas")).toBeInTheDocument();
    expect(screen.getAllByText("Loja").length).toBe(8);
    expect(screen.getAllByText("loja@example.com").length).toBe(8);
    expect(screen.getByText("Mostrando 8 de 8 tentativas.")).toBeInTheDocument();
    cleanup();
    setLocale("en", { persist: false });
    render(<RefusalsSection />);
    expect(await screen.findByText("Wrong username or password")).toBeInTheDocument();
    expect(screen.getByText("Message too large")).toBeInTheDocument();
  });

  it("clicar na tentativa abre os detalhes (motivo, o que fazer, login, projeto, origem, porta) e clicar de novo fecha", async () => {
    apiFetchMock.mockResolvedValue(
      refusals([refusal({ listener: "submission" }), refusal({ at: "2026-10-24T10:00:00Z", origin: "unknown", login: null, listener: null, kind: "futuro" as never })]),
    );
    render(<RefusalsSection />);
    await screen.findByText("Usuário ou senha errados");
    expect(screen.queryByTestId("refusal-details-0")).not.toBeInTheDocument();
    const toggle = screen.getByTestId("refusal-toggle-0");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    const details = await screen.findByTestId("refusal-details-0");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(details).toHaveTextContent("Origem:rede interna (app ou painel)");
    expect(details).toHaveTextContent("Porta de envio:submission");
    expect(details).toHaveTextContent("Projeto:Loja");
    expect(details).toHaveTextContent("loja@example.com");
    expect(details).toHaveTextContent("O que fazer:");
    expect(details).toHaveTextContent("antes de a mensagem entrar na fila");
    // abrir outra fecha a anterior; tipo desconhecido e campos ausentes não quebram
    fireEvent.click(screen.getByTestId("refusal-toggle-1"));
    const second = await screen.findByTestId("refusal-details-1");
    expect(screen.queryByTestId("refusal-details-0")).not.toBeInTheDocument();
    expect(second).toHaveTextContent("Origem:não identificada");
    expect(second).toHaveTextContent("Porta de envio:não registrada");
    expect(second).toHaveTextContent("Sem orientação para este tipo de recusa.");
    expect(second).toHaveTextContent("Login:não registrado");
    fireEvent.click(screen.getByTestId("refusal-toggle-1"));
    expect(screen.queryByTestId("refusal-details-1")).not.toBeInTheDocument();
  });

  it("detalhes na visão do projeto e da internet; em inglês", async () => {
    apiFetchMock.mockResolvedValue(refusals([refusal({ origin: "external", projectName: null, projectId: null })]));
    render(<RefusalsSection projectId="p1" />);
    fireEvent.click(await screen.findByTestId("refusal-toggle-0"));
    expect(await screen.findByTestId("refusal-details-0")).toHaveTextContent("Origem:internet");
    cleanup();
    setLocale("en", { persist: false });
    apiFetchMock.mockResolvedValue(refusals([refusal()]));
    render(<RefusalsSection />);
    fireEvent.click(await screen.findByTestId("refusal-toggle-0"));
    expect(await screen.findByTestId("refusal-details-0")).toHaveTextContent("Origin:internal network (app or panel)");
  });

  it("tentativas externas: pede scope=external, título e descrição próprios, não acusa o app", async () => {
    apiFetchMock.mockResolvedValue(refusals([refusal({ origin: "external", projectName: null, projectId: null, login: "bot@x.com" })]));
    render(<RefusalsSection external />);
    expect(await screen.findByText("bot@x.com")).toBeInTheDocument();
    expect(apiFetchMock.mock.calls[0]![0]).toBe("/api/mail/envios/recusas?scope=external&limit=50");
    expect(screen.getByText("Tentativas externas (internet)")).toBeInTheDocument();
    expect(screen.getByText(/Não são do seu app/)).toBeInTheDocument();
    expect(screen.getByTestId("refusals-external")).toBeInTheDocument();
  });

  it("visão do projeto: rota do projeto, sem coluna de projeto; login ausente e tipo novo não quebram", async () => {
    apiFetchMock.mockResolvedValue(refusals([refusal({ login: null, projectName: null, projectId: null }), refusal({ kind: "futuro" as never })]));
    render(<RefusalsSection projectId="p 1" />);
    expect(await screen.findByText("não registrado")).toBeInTheDocument();
    expect(apiFetchMock.mock.calls[0]![0]).toBe("/api/projects/p%201/email/recusas?limit=50");
    expect(screen.queryByRole("columnheader", { name: "Projeto" })).not.toBeInTheDocument();
    expect(screen.getByText("futuro")).toBeInTheDocument();
  });

  it("visão global com recusa sem projeto", async () => {
    apiFetchMock.mockResolvedValue(refusals([refusal({ projectName: null })]));
    render(<RefusalsSection />);
    expect(await screen.findByText("sem projeto")).toBeInTheDocument();
  });

  it("vazio: explica os dias e, sem servidor criado, avisa disso", async () => {
    apiFetchMock.mockResolvedValue(refusals([], { collectedAt: null }));
    render(<RefusalsSection />);
    expect(await screen.findByTestId("refusals-empty")).toHaveTextContent("Nenhuma tentativa recusada nos últimos 14 dias.");
    expect(screen.getByTestId("refusals-empty")).not.toHaveTextContent("ainda não foi criado");
    cleanup();
    apiFetchMock.mockResolvedValue(refusals([], { serverCreated: false }));
    render(<RefusalsSection />);
    expect(await screen.findByTestId("refusals-empty")).toHaveTextContent("O servidor de e-mail ainda não foi criado");
  });

  it("confere de novo a cada minuto sem apagar a lista quando a consulta automática falha", async () => {
    vi.useFakeTimers();
    try {
      apiFetchMock.mockResolvedValue(refusals([refusal()]));
      render(<RefusalsSection />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText("Usuário ou senha errados")).toBeInTheDocument();
      apiFetchMock.mockRejectedValue(new ApiRequestError(500, "x", "boom"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(apiFetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(screen.getByText("Usuário ou senha errados")).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      apiFetchMock.mockResolvedValue(refusals([refusal({ kind: "rate_limited" })]));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(screen.getByText("Limite de envios ou conexões atingido")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("erro mostra aviso; atualizar tenta de novo", async () => {
    apiFetchMock.mockRejectedValueOnce(new ApiRequestError(500, "x", "boom"));
    render(<RefusalsSection />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível carregar as tentativas recusadas.");
    apiFetchMock.mockResolvedValue(refusals([refusal()]));
    fireEvent.click(screen.getByRole("button", { name: /Atualizar/ }));
    expect(await screen.findByText("Usuário ou senha errados")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("MailDiagnosisPanel: última tentativa", () => {
  it("nunca vista, aceita e recusada com motivo", async () => {
    apiFetchMock.mockResolvedValue(diag());
    render(<MailDiagnosisPanel projectId="p1" />);
    expect(await screen.findByTestId("last-attempt")).toHaveTextContent("Última tentativa de conexão do app: nunca vista");
    expect(apiFetchMock.mock.calls[0]![0]).toBe("/api/projects/p1/email/diagnostico");
    expect(screen.queryByTestId("why-nothing")).not.toBeInTheDocument();
    cleanup();
    apiFetchMock.mockResolvedValue(diag({ lastAttempt: { at: "2026-10-24T11:00:00Z", outcome: "accepted", kind: null } }));
    render(<MailDiagnosisPanel projectId="p1" />);
    expect(await screen.findByTestId("last-attempt")).toHaveTextContent(/aceita/);
    cleanup();
    apiFetchMock.mockResolvedValue(diag({ lastAttempt: { at: "2026-10-24T11:00:00Z", outcome: "refused", kind: "tls_error" } }));
    render(<MailDiagnosisPanel projectId="p1" />);
    expect(await screen.findByTestId("last-attempt")).toHaveTextContent(/recusada \(Falha na conexão segura \(TLS\)\)/);
    cleanup();
    apiFetchMock.mockResolvedValue(diag({ lastAttempt: { at: "2026-10-24T11:00:00Z", outcome: "refused", kind: null } }));
    render(<MailDiagnosisPanel projectId="p1" />);
    expect(await screen.findByTestId("last-attempt")).toHaveTextContent(/: recusada$/);
  });

  it("falha na consulta ou resposta fora do formato não mostra nada", async () => {
    apiFetchMock.mockRejectedValue(new ApiRequestError(500, "x", "boom"));
    const { container } = render(<MailDiagnosisPanel projectId="p1" />);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    cleanup();
    apiFetchMock.mockResolvedValue({});
    const second = render(<MailDiagnosisPanel projectId="p1" />);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2));
    expect(second.container).toBeEmptyDOMElement();
  });
});

describe("MailDiagnosisPanel: por que nada chegou", () => {
  const CASES: { code: MailHintCode; params?: Record<string, string>; text: RegExp }[] = [
    { code: "email_disabled", text: /Ative o e-mail na aba E-mail/ },
    { code: "no_mailbox", text: /Escolha ou crie uma caixa/ },
    { code: "test_inbox_on", text: /caixa de teste/ },
    { code: "needs_restart", text: /novo deploy ou reinicie/ },
    { code: "mailer_not_smtp", params: { mailer: "log" }, text: /MAIL_MAILER está como log/ },
    { code: "smtp_not_linked", params: { names: "MAIL_HOST, MAIL_PORT" }, text: /Ligue MAIL_HOST, MAIL_PORT.*Ligar variáveis/ },
    { code: "queue_no_worker", text: /QUEUE_CONNECTION=sync.*serviço worker.*Solução de problemas de e-mail/ },
    { code: "recent_refusals", params: { count: "4", kind: "auth_failed" }, text: /4 tentativas recentes \(Usuário ou senha errados\).*Tentativas recusadas/ },
    { code: "app_never_connected", text: /nunca se conectou/ },
  ];

  it.each(CASES)("item $code", async ({ code, params, text }) => {
    apiFetchMock.mockResolvedValue(diag({ noSendsRecent: true, hints: [{ code, severity: code === "app_never_connected" ? "info" : "problem", params }] }));
    render(<MailDiagnosisPanel projectId="p1" />);
    const card = await screen.findByTestId("why-nothing");
    expect(within(card).getByText("Por que nada chegou?")).toBeInTheDocument();
    expect(within(card).getByTestId(`hint-${code}`)).toHaveTextContent(text);
    expect(within(card).getByRole("link", { name: "Solução de problemas de e-mail" })).toHaveAttribute("href", expect.stringContaining("/pt-br/guides/troubleshooting/"));
  });

  it("sem itens: diz que nada foi encontrado e sugere o teste; item desconhecido é ignorado", async () => {
    apiFetchMock.mockResolvedValue(diag({ noSendsRecent: true }));
    render(<MailDiagnosisPanel projectId="p1" />);
    expect(await screen.findByText(/Nada de errado foi encontrado.*Testar conexão a partir do app/)).toBeInTheDocument();
    cleanup();
    apiFetchMock.mockResolvedValue(diag({ noSendsRecent: true, hints: [{ code: "zzz" as MailHintCode, severity: "info" }] }));
    render(<MailDiagnosisPanel projectId="p1" />);
    expect(await screen.findByText(/Nada de errado foi encontrado/)).toBeInTheDocument();
  });

  it("em inglês", async () => {
    setLocale("en", { persist: false });
    apiFetchMock.mockResolvedValue(diag({ noSendsRecent: true, hints: [{ code: "queue_no_worker", severity: "problem" }, { code: "app_never_connected", severity: "info" }] }));
    render(<MailDiagnosisPanel projectId="p1" />);
    expect(await screen.findByText("Why did nothing arrive?")).toBeInTheDocument();
    expect(screen.getByText(/Last connection attempt from the app/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "E-mail troubleshooting" })).toHaveAttribute("href", expect.stringContaining("/en/guides/"));
    expect(screen.getByText("problem")).toBeInTheDocument();
    expect(screen.getByText("may be the cause")).toBeInTheDocument();
  });
});

describe("ProjectNotices", () => {
  it("fila sem worker é aviso visível com o texto exato e as duas soluções", async () => {
    apiFetchMock.mockResolvedValue(diag({ notices: [{ code: "queue_no_worker", severity: "warning" }] }));
    render(<ProjectNotices projectId="p1" />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Não encontramos um worker da fila — e-mails e tarefas enfileiradas podem ficar parados");
    expect(alert).toHaveTextContent("QUEUE_CONNECTION=sync");
    expect(alert).toHaveTextContent("serviço worker");
    expect(apiFetchMock.mock.calls[0]![0]).toBe("/api/projects/p1/email/diagnostico?only=notices");
    expect(screen.queryByTestId("notice-log_channel_stderr")).not.toBeInTheDocument();
  });

  it("em inglês", async () => {
    setLocale("en", { persist: false });
    apiFetchMock.mockResolvedValue(diag({ notices: [{ code: "queue_no_worker", severity: "warning" }] }));
    render(<ProjectNotices projectId="p1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("We could not find a queue worker — queued e-mails and jobs may stay stuck");
  });

  it("LOG_CHANNEL é dica discreta (sem alerta) e pode ser dispensada por projeto", async () => {
    apiFetchMock.mockResolvedValue(diag({ notices: [{ code: "log_channel_stderr", severity: "info" }] }));
    render(<ProjectNotices projectId="p1" />);
    const tip = await screen.findByTestId("notice-log_channel_stderr");
    expect(tip).toHaveTextContent("LOG_CHANNEL=stderr");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dispensar dica" }));
    expect(screen.queryByTestId("notice-log_channel_stderr")).not.toBeInTheDocument();
    cleanup();
    render(<ProjectNotices projectId="p1" />);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("notice-log_channel_stderr")).not.toBeInTheDocument();
    cleanup();
    render(<ProjectNotices projectId="outro" />);
    expect(await screen.findByTestId("notice-log_channel_stderr")).toBeInTheDocument();
  });

  it("dispensar sem armazenamento disponível ainda esconde a dica", async () => {
    apiFetchMock.mockResolvedValue(diag({ notices: [{ code: "log_channel_stderr", severity: "info" }] }));
    render(<ProjectNotices projectId="p1" />);
    await screen.findByTestId("notice-log_channel_stderr");
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("cheio");
    });
    fireEvent.click(screen.getByRole("button", { name: "Dispensar dica" }));
    expect(screen.queryByTestId("notice-log_channel_stderr")).not.toBeInTheDocument();
    spy.mockRestore();
  });

  it("sem acesso ao armazenamento a dica aparece normalmente", async () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    apiFetchMock.mockResolvedValue(diag({ notices: [{ code: "log_channel_stderr", severity: "info" }] }));
    render(<ProjectNotices projectId="p1" />);
    expect(await screen.findByTestId("notice-log_channel_stderr")).toBeInTheDocument();
    spy.mockRestore();
  });

  it("falha ou resposta sem avisos não renderiza nada", async () => {
    apiFetchMock.mockRejectedValue(new ApiRequestError(500, "x", "boom"));
    const { container } = render(<ProjectNotices projectId="p1" />);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    cleanup();
    apiFetchMock.mockResolvedValue({});
    const second = render(<ProjectNotices projectId="p1" />);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2));
    expect(second.container).toBeEmptyDOMElement();
  });
});

describe("MailProbe", () => {
  const ok: MailProbeResult = { ok: true, host: "mail.example.com", port: 587, passed: ["connect", "ehlo", "starttls", "certificate", "auth"], failedStep: null, failure: null, detail: null, elapsedMs: 120 };

  it("explica que nada é enviado, mostra ocupado e depois todas as etapas como passadas", async () => {
    let release: (r: MailProbeResult) => void = () => {};
    apiFetchMock.mockReturnValue(new Promise((res) => (release = res)));
    render(<MailProbe projectId="p1" />);
    expect(screen.getByText(/Nenhuma mensagem é enviada.*mesma rede Docker/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Testar conexão a partir do app/ }));
    const busy = await screen.findByRole("button", { name: /Testando/ });
    expect(busy).toBeDisabled();
    expect(apiFetchMock).toHaveBeenCalledWith("/api/projects/p1/email/testar-conexao", { method: "POST" });
    release(ok);
    const result = await screen.findByTestId("probe-result");
    expect(result).toHaveTextContent("Conexão e login funcionaram em mail.example.com:587 (120 ms).");
    const steps = within(result).getAllByRole("listitem");
    expect(steps).toHaveLength(5);
    expect(steps.every((s) => s.getAttribute("data-state") === "passed")).toBe(true);
    expect(screen.queryByTestId("probe-failure")).not.toBeInTheDocument();
    expect(result.querySelector("details")).toBeNull();
  });

  const FAILS: { failedStep: MailProbeResult["failedStep"]; passed: MailProbeResult["passed"]; failure: NonNullable<MailProbeResult["failure"]>; text: RegExp }[] = [
    { failedStep: "connect", passed: [], failure: "dns", text: /encontrar o endereço/ },
    { failedStep: "connect", passed: [], failure: "refused", text: /recusou a conexão/ },
    { failedStep: "connect", passed: [], failure: "timeout", text: /não respondeu a tempo/ },
    { failedStep: "ehlo", passed: ["connect"], failure: "reset", text: /interrompida/ },
    { failedStep: "ehlo", passed: ["connect"], failure: "closed", text: /fechou a conexão/ },
    { failedStep: "connect", passed: [], failure: "greeting", text: /saudação esperada/ },
    { failedStep: "ehlo", passed: ["connect"], failure: "ehlo_rejected", text: /rejeitou a apresentação/ },
    { failedStep: "starttls", passed: ["connect", "ehlo"], failure: "starttls_unavailable", text: /não oferece STARTTLS/ },
    { failedStep: "starttls", passed: ["connect", "ehlo"], failure: "starttls_rejected", text: /rejeitou o STARTTLS/ },
    { failedStep: "certificate", passed: ["connect", "ehlo", "starttls"], failure: "certificate", text: /certificado do servidor não foi aceito/ },
    { failedStep: "auth", passed: ["connect", "ehlo", "starttls", "certificate"], failure: "auth_rejected", text: /recusou o login da caixa do projeto/ },
    { failedStep: "auth", passed: ["connect", "ehlo", "starttls", "certificate"], failure: "auth_unsupported", text: /não aceita o login/ },
    { failedStep: "auth", passed: ["connect", "ehlo", "starttls", "certificate"], failure: "unexpected", text: /Resposta inesperada/ },
  ];

  it.each(FAILS)("falha na etapa $failedStep por $failure", async ({ failedStep, passed, failure, text }) => {
    apiFetchMock.mockResolvedValue({ ok: false, host: "mail.example.com", port: 587, passed, failedStep, failure, detail: "535 5.7.8 rejeitado", elapsedMs: 30 } satisfies MailProbeResult);
    render(<MailProbe projectId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: /Testar conexão/ }));
    const result = await screen.findByTestId("probe-result");
    expect(result).toHaveAttribute("data-ok", "false");
    expect(screen.getByTestId("probe-failure")).toHaveTextContent(text);
    const states = within(result).getAllByRole("listitem").map((s) => s.getAttribute("data-state"));
    expect(states.filter((s) => s === "failed")).toHaveLength(1);
    expect(within(result).getAllByText(/\(falhou\)/)).toHaveLength(1);
    expect(result.querySelector("details")).not.toHaveAttribute("open");
    expect(result.querySelector("details")).toHaveTextContent("Detalhes técnicos");
    expect(result.querySelector("details")).toHaveTextContent("535 5.7.8 rejeitado");
  });

  it("falha na etapa mostra o nome dela e as etapas seguintes como não alcançadas; sem credenciais na tela", async () => {
    apiFetchMock.mockResolvedValue({ ok: false, host: "mail.example.com", port: 587, passed: ["connect"], failedStep: "ehlo", failure: "closed", detail: null, elapsedMs: 5 });
    const { container } = render(<MailProbe projectId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: /Testar conexão/ }));
    const result = await screen.findByTestId("probe-result");
    expect(result).toHaveTextContent('falhou na etapa "Apresentação (EHLO)"');
    expect(result).toHaveTextContent("não chegou");
    expect(container.querySelector("details")).toBeNull();
    expect(container.textContent).not.toMatch(/senha=|password=|SMTP_PASS=/i);
  });

  it.each([
    [409, "email_not_enabled", /e-mail deste projeto não está ativado/],
    [409, "probe_running", /Já há um teste em andamento/],
    [429, "rate_limited", /Muitos testes em pouco tempo/],
    [500, "internal", /Não foi possível fazer o teste/],
  ])("erro %s %s", async (status, code, text) => {
    apiFetchMock.mockRejectedValue(new ApiRequestError(status, code, "x"));
    render(<MailProbe projectId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: /Testar conexão/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
    expect(screen.getByRole("button", { name: /Testar conexão/ })).not.toBeDisabled();
  });

  it("erro que não é da API cai na mensagem genérica; em inglês", async () => {
    setLocale("en", { persist: false });
    apiFetchMock.mockRejectedValue(new Error("rede"));
    render(<MailProbe projectId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: "Test connection from the app" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not run the connection test.");
  });
});
