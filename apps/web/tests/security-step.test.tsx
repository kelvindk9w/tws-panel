/**
 * security-step.test.tsx — plano de correção do wizard de segurança:
 *  - ação principal por fase: "Executar apenas esta fase";
 *  - ação secundária "Fazer manualmente" abre o MODAL com passo a passo
 *    copiável + botão "Já executei — revarrer";
 *  - Fase 01: tutorial guiado de chave SSH presente (o que é, para que serve,
 *    comandos por SO) + validação "Sua chave parece válida ✅".
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SecurityPlan, SecurityScanReport } from "@paas/core";

// ---------------------------------------------------------------------------
// Mock da API
// ---------------------------------------------------------------------------

const SCAN_REPORT: SecurityScanReport = {
  id: "scan-1",
  scannedAt: new Date().toISOString(),
  durationMs: 1200,
  target: "host",
  hardeningIndex: 62,
  hardeningIndexSource: "internal",
  lynisAvailable: false,
  checks: [],
  summary: { total: 2, pass: 0, fail: 2, unknown: 0, critical: 1, warning: 1 },
  profile: "host",
  skippedChecks: [],
  profileNote: null,
};

const HISTORY_EMPTY = {
  entries: [],
  firstIndex: null,
  latestIndex: null,
  applied: null,
};

const PLAN: SecurityPlan = {
  id: "plan-1",
  createdAt: new Date().toISOString(),
  basedOnScanId: "scan-1",
  hardeningIndex: 62,
  actions: [
    {
      id: "apply-00",
      phase: "00",
      phaseKey: "update",
      title: "Atualizações do sistema",
      script: "00-update.sh",
      description: "Atualiza pacotes do SO.",
      fixesCheckIds: ["os.updates"],
      requiresConfirmation: false,
      hasRollback: false,
      impact: null,
      preselected: true,
      alreadySatisfied: false,
    },
    {
      id: "apply-01",
      phase: "01",
      phaseKey: "user",
      title: "Usuário não-root",
      script: "01-user.sh",
      description: "Valida o usuário não-root e instala a chave SSH.",
      fixesCheckIds: ["user.non-root-sudo"],
      requiresConfirmation: true,
      hasRollback: true,
      impact: "A senha do root será travada.",
      preselected: true,
      alreadySatisfied: false,
    },
  ],
};

const apiFetchMock = vi.fn(async (path: string, init?: RequestInit) => {
  if (path === "/api/security/history") return HISTORY_EMPTY;
  if (path.startsWith("/api/security/scan")) return { report: SCAN_REPORT, cached: false };
  if (path === "/api/security/plan") return PLAN;
  if (path === "/api/security/phases/00/manual") {
    return {
      phase: "00",
      phaseKey: "update",
      title: "Atualizações do sistema",
      script: "00-update.sh",
      commands: ["sudo bash /opt/tws-panel/scripts/hardening/00-update.sh"],
      scriptContent: "#!/usr/bin/env bash\necho update\n",
      notes: ["Adicione --dry-run para simular sem alterar nada."],
    };
  }
  if (path === "/api/security/apply") {
    return {
      job: {
        id: "job-1",
        phase: "00",
        phaseKey: "update",
        title: "Atualizações do sistema",
        dryRun: true,
        status: "running",
        createdAt: "",
        startedAt: null,
        finishedAt: null,
        steps: [],
        log: "",
        rollbackScheduled: false,
        rollbackDeadline: null,
        error: null,
      },
    };
  }
  throw new Error(`chamada inesperada: ${init?.method ?? "GET"} ${path}`);
});

vi.mock("@/lib/api", () => ({
  apiFetch: (path: string, init?: RequestInit) => apiFetchMock(path, init),
  ApiRequestError: class extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));

import { SecurityStep } from "@/pages/setup/SecurityStep";

async function reachPlanStage() {
  render(<SecurityStep onNext={() => undefined} onBack={() => undefined} />);
  fireEvent.click(await screen.findByText("Iniciar varredura"));
  fireEvent.click(await screen.findByText("Gerar plano de correção"));
  await screen.findByText(/Fase 00 — Atualizações do sistema/);
}

beforeEach(() => {
  sessionStorage.clear();
  apiFetchMock.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("SecurityStep — retomada após restart do painel", () => {
  it("histórico com hardening aplicado → monta em 'Hardening aplicado' com Continuar", async () => {
    // Estado persistido no servidor: apply real concluído (restart simulado —
    // o componente monta do zero e consulta o histórico server-side).
    apiFetchMock.mockImplementationOnce(async (path: string) => {
      if (path === "/api/security/history") {
        return {
          entries: [],
          firstIndex: 39,
          latestIndex: 75,
          applied: {
            appliedAt: "2026-08-21T10:20:00Z",
            beforeIndex: 39,
            beforeIndexSource: "lynis",
            afterIndex: 75,
            afterIndexSource: "lynis",
          },
        };
      }
      throw new Error(`chamada inesperada: GET ${path}`);
    });
    const onNext = vi.fn();
    render(<SecurityStep onNext={onNext} onBack={() => undefined} />);

    // restaura a visão "Hardening aplicado" — NÃO a tela "Iniciar varredura"
    expect(await screen.findByText("Hardening aplicado")).toBeInTheDocument();
    expect(screen.queryByText("Iniciar varredura")).not.toBeInTheDocument();

    // Antes/Depois estáveis, vindos do snapshot persistido
    expect(screen.getByText("Antes")).toBeInTheDocument();
    expect(screen.getByText("39")).toBeInTheDocument();
    expect(screen.getByText("Depois")).toBeInTheDocument();
    expect(screen.getByText("75")).toBeInTheDocument();

    // caminho para avançar ao passo 4 sem re-rodar plano/dry-run/apply
    fireEvent.click(screen.getByRole("button", { name: /Continuar/ }));
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("histórico sem apply → fluxo normal ('Iniciar varredura')", async () => {
    render(<SecurityStep onNext={() => undefined} onBack={() => undefined} />);
    expect(await screen.findByText("Iniciar varredura")).toBeInTheDocument();
    expect(screen.queryByText("Hardening aplicado")).not.toBeInTheDocument();
  });
});

describe("SecurityStep — plano de correção", () => {
  it("cada fase pendente tem a ação principal 'Executar apenas esta fase' e a secundária 'Fazer manualmente'", async () => {
    await reachPlanStage();
    const executar = screen.getAllByRole("button", { name: /Executar apenas esta fase/ });
    expect(executar).toHaveLength(2); // fases 00 e 01 pendentes
    const manual = screen.getAllByRole("button", { name: /Fazer manualmente/ });
    expect(manual).toHaveLength(2);
  });

  it("'Fazer manualmente' abre o modal com passo a passo copiável e 'Já executei — revarrer'", async () => {
    await reachPlanStage();
    fireEvent.click(screen.getAllByRole("button", { name: /Fazer manualmente/ })[0]!);

    const modal = await screen.findByRole("dialog");
    expect(modal).toHaveTextContent("Fazer manualmente — Fase 00");
    expect(await screen.findByText("sudo bash /opt/tws-panel/scripts/hardening/00-update.sh")).toBeInTheDocument();
    expect(screen.getByText(/Passo a passo — comandos exatos/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Já executei — revarrer/ })).toBeInTheDocument();

    // fecha pelo botão Fechar
    fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("'Já executei — revarrer' dispara scan fresco + novo plano", async () => {
    await reachPlanStage();
    fireEvent.click(screen.getAllByRole("button", { name: /Fazer manualmente/ })[0]!);
    await screen.findByRole("dialog");
    fireEvent.click(await screen.findByRole("button", { name: /Já executei — revarrer/ }));
    await waitFor(() => {
      const calls = apiFetchMock.mock.calls.map(([p]) => String(p));
      expect(calls).toContain("/api/security/scan?fresh=1");
    });
  });

  it("tutorial guiado de chave SSH está recolhido por padrão e expande sob demanda na Fase 01", async () => {
    await reachPlanStage();
    expect(screen.getByText(/Nunca usou chave SSH\? Veja como gerar em 2 minutos/)).toBeInTheDocument();
    // fechado por padrão: o conteúdo do tutorial não aparece antes de expandir
    expect(screen.queryByText(/O que é:/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Veja como gerar em 2 minutos/ }));
    expect(screen.getByText(/O que é:/)).toBeInTheDocument();
    expect(screen.getByText(/depois que o acesso root for desativado/)).toBeInTheDocument();
    expect(screen.getAllByText("ssh-keygen -t ed25519")).toHaveLength(2); // Windows + Linux/Mac
    expect(screen.getByText(/Windows \(PowerShell\)/)).toBeInTheDocument();
    expect(screen.getByText(/Linux \/ 🍎 macOS \(Terminal\)/)).toBeInTheDocument();
    expect(screen.getAllByText(/~\/\.ssh\/id_ed25519\.pub/).length).toBeGreaterThan(0);
  });

  it("fase 01 explica que, se usuário e chave já existem, a fase ainda desativa a senha do root", async () => {
    await reachPlanStage();
    expect(screen.getByText(/desativar a senha do usuário root/i)).toBeInTheDocument();
  });

  it("campo de usuário tem placeholder curto e a explicação como texto auxiliar", async () => {
    await reachPlanStage();
    const campo = screen.getByLabelText(/Usuário não-root criado na instalação/);
    expect(campo).toHaveAttribute("placeholder", "deploy");
    expect(screen.getByText(/nome que você criou/i)).toBeInTheDocument();
  });

  it("valida o formato da chave ao colar e mostra 'Sua chave parece válida ✅'", async () => {
    await reachPlanStage();
    const campo = screen.getByLabelText(/Chave pública/);
    fireEvent.change(campo, { target: { value: "nao-e-uma-chave" } });
    expect(screen.getByText(/Formato não reconhecido/)).toBeInTheDocument();

    fireEvent.change(campo, {
      target: {
        value:
          "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILSr6Jdm+iXYbln6BfkP2uCTKNO/eVi89lEjP7rH7dHN eu@notebook",
      },
    });
    expect(screen.getByText("Sua chave parece válida ✅")).toBeInTheDocument();
  });

  it("Fase 01 exige usuário + chave para habilitar 'Executar apenas esta fase'", async () => {
    await reachPlanStage();
    const [, fase01Btn] = screen.getAllByRole("button", { name: /Executar apenas esta fase/ });
    expect(fase01Btn!.closest("button")).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Usuário não-root criado na instalação/), {
      target: { value: "kelvin" },
    });
    fireEvent.change(screen.getByLabelText(/Chave pública/), {
      target: {
        value:
          "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILSr6Jdm+iXYbln6BfkP2uCTKNO/eVi89lEjP7rH7dHN eu@notebook",
      },
    });
    expect(fase01Btn!.closest("button")).toBeEnabled();
  });
});
