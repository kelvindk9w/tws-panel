/**
 * Testes do modal de override de guardrails: o botão "Deploy com override"
 * só habilita após o checkbox explícito de aceite de risco.
 */
import { cleanup, render, screen } from "@testing-library/react";
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
    expect(confirmButton).toBeEnabled();

    // desmarcar volta a desabilitar
    await user.click(screen.getByRole("checkbox", { name: /entendo os riscos/i }));
    expect(confirmButton).toBeDisabled();
  });

  it("confirmar chama onConfirm; cancelar chama onCancel", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<GuardrailOverrideModal report={REPORT} busy={false} onCancel={onCancel} onConfirm={onConfirm} />);

    await user.click(screen.getByRole("checkbox", { name: /entendo os riscos/i }));
    await user.click(screen.getByRole("button", { name: /deploy com override/i }));
    expect(onConfirm).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: /cancelar/i }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("busy desabilita ambos os botões (deploy em andamento)", () => {
    render(<GuardrailOverrideModal report={REPORT} busy onCancel={() => undefined} onConfirm={() => undefined} />);
    expect(screen.getByRole("button", { name: /cancelar/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /deploy com override/i })).toBeDisabled();
  });
});
