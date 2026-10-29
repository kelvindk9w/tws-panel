/**
 * Testes do modal de override de guardrails: o botão "Deploy com override"
 * só habilita após o checkbox explícito de aceite de risco.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GuardrailReport } from "@paas/core";
import { GuardrailOverrideModal } from "../src/pages/ProjectDetailPage";

const REPORT: GuardrailReport = {
  ranAt: new Date().toISOString(),
  dir: "/tmp/loja",
  findings: [
    {
      rule: "db-port-exposed",
      level: "block",
      title: "Porta de banco de dados publicada no host (PostgreSQL)",
      evidence: "compose.yml: serviço \"db\" publica 5432:5432",
      fix: "Remova a entrada de ports.",
      service: "db",
    },
    {
      rule: "dev-service-in-prod",
      level: "warn",
      title: "Serviço de desenvolvimento no deploy (Mailhog)",
      evidence: "compose.yml: serviço \"mail\"",
      fix: "Remova do compose de produção.",
      service: "mail",
    },
  ],
  blockers: 1,
  warnings: 1,
  infos: 0,
};

afterEach(cleanup);

function fillReauth(): void {
  fireEvent.change(screen.getByLabelText("Senha do painel"), { target: { value: "MinhaSenha123" } });
  fireEvent.change(document.getElementById("override-code")!, { target: { value: "123456" } });
}

describe("GuardrailOverrideModal", () => {
  it("lista os findings com a contagem de bloqueios e alertas", () => {
    render(<GuardrailOverrideModal report={REPORT} busy={false} onCancel={() => undefined} onConfirm={() => undefined} />);
    expect(screen.getByText(/Deploy bloqueado pelos guardrails/)).toBeInTheDocument();
    expect(screen.getByText(/1 violação\(ões\)/)).toBeInTheDocument();
    expect(screen.getByText(/Porta de banco de dados publicada no host/)).toBeInTheDocument();
    expect(screen.getByText(/Mailhog/)).toBeInTheDocument();
  });

  it("botão de override começa desabilitado e só habilita com o checkbox", async () => {
    const user = userEvent.setup();
    render(<GuardrailOverrideModal report={REPORT} busy={false} onCancel={() => undefined} onConfirm={() => undefined} />);

    const confirmButton = screen.getByRole("button", { name: /deploy com override/i });
    expect(confirmButton).toBeDisabled();

    await user.click(screen.getByRole("checkbox", { name: /entendo os riscos/i }));
    // marcar o aceite abre a reautenticação: sem senha e código ainda não dá
    expect(confirmButton).toBeDisabled();
    fillReauth();
    expect(confirmButton).toBeEnabled();

    // desmarcar volta a desabilitar (e some a reautenticação)
    await user.click(screen.getByRole("checkbox", { name: /entendo os riscos/i }));
    expect(confirmButton).toBeDisabled();
    expect(screen.queryByLabelText("Senha do painel")).toBeNull();
  });

  it("confirmar chama onConfirm; cancelar chama onCancel", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<GuardrailOverrideModal report={REPORT} busy={false} onCancel={onCancel} onConfirm={onConfirm} />);

    await user.click(screen.getByRole("checkbox", { name: /entendo os riscos/i }));
    fillReauth();
    await user.click(screen.getByRole("button", { name: /deploy com override/i }));
    // a prova (senha + código do app) segue junto: sem ela o servidor recusa o override
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onConfirm).toHaveBeenCalledWith({ password: "MinhaSenha123", code: "123456", emailCode: "" });

    await user.click(screen.getByRole("button", { name: /cancelar/i }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("busy desabilita ambos os botões (deploy em andamento)", () => {
    render(<GuardrailOverrideModal report={REPORT} busy onCancel={() => undefined} onConfirm={() => undefined} />);
    expect(screen.getByRole("button", { name: /cancelar/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /deploy com override/i })).toBeDisabled();
  });

  it("mostra o motivo da recusa (senha ou código errado, sem 2FA) dentro do diálogo", async () => {
    const user = userEvent.setup();
    render(<GuardrailOverrideModal report={REPORT} busy={false} onCancel={() => undefined} onConfirm={() => undefined} error="Código incorreto ou já usado." />);
    await user.click(screen.getByRole("checkbox", { name: /entendo os riscos/i }));
    expect(screen.getByRole("alert")).toHaveTextContent("Código incorreto ou já usado.");
    expect(screen.getByText(/pode dar acesso de administrador à VPS/)).toBeInTheDocument();
  });

  it("porta 80/443 com proxy HTTPS próprio: sem override (o deploy falharia igual) e com o caminho a seguir", () => {
    const report: GuardrailReport = {
      ...REPORT,
      findings: [
        {
          rule: "proxy-port-conflict",
          level: "block",
          title: "Porta 443 do servidor publicada pelo projeto",
          evidence: 'compose.prod.yaml: serviço "ledger" publica 443:443',
          fix: "Crie no repositório um compose.paas.yaml.",
          service: "ledger",
        },
      ],
      blockers: 1,
      warnings: 0,
    };
    render(<GuardrailOverrideModal report={report} busy={false} onCancel={() => undefined} onConfirm={() => undefined} />);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /deploy com override/i })).not.toBeInTheDocument();
    expect(screen.getByTestId("no-override")).toHaveTextContent(/não tem como forçar/);
    expect(screen.getByRole("button", { name: /Fechar/ })).toBeInTheDocument();
  });
});
