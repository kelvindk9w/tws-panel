/**
 * security-step.test.tsx — plano de correção do wizard de segurança:
 *  - ação principal por fase: "Executar apenas esta fase";
 *  - ação secundária "Fazer manualmente" abre o MODAL com passo a passo
 *    copiável + botão "Já executei — verificar de novo";
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
    {
      id: "apply-02",
      phase: "02",
      phaseKey: "ssh",
      title: "Hardening de SSH",
      script: "02-ssh.sh",
      description: "Drop-in de hardening do sshd.",
      fixesCheckIds: ["ssh.root-login"],
      requiresConfirmation: true,
      hasRollback: true,
      impact: "Senha e root são desabilitados no SSH.",
      preselected: true,
      alreadySatisfied: false,
    },
  ],
};

/**
 * Usuários não-root com sudo que a varredura devolve NESTA execução de teste.
 * `undefined` reproduz um relatório antigo, persistido antes de a detecção
 * existir — o campo é opcional no contrato e a UI deve tratá-lo como lista
 * vazia. Cada teste ajusta o valor antes de chegar ao plano.
 */
let detectedSudoUsers: string[] | undefined;
/** Senha/chaves de cada usuário detectado (undefined = relatório antigo). */
let sudoAccess: SecurityScanReport["nonRootSudoUserAccess"];

/** Endereço simulado da página (o jsdom fica preso em http://localhost). */
let fakeLocation: { protocol: string; hostname: string; port?: string } = {
  protocol: "http:",
  hostname: "localhost",
};
vi.mock("@/lib/page-location", () => ({ pageLocation: () => fakeLocation }));

const apiFetchMock = vi.fn(async (path: string, init?: RequestInit) => {
  if (path === "/api/security/history") return HISTORY_EMPTY;
  if (path.startsWith("/api/security/scan")) {
    const report: SecurityScanReport = detectedSudoUsers
      ? {
          ...SCAN_REPORT,
          nonRootSudoUsers: detectedSudoUsers,
          ...(sudoAccess ? { nonRootSudoUserAccess: sudoAccess } : {}),
        }
      : SCAN_REPORT;
    return { report, cached: false };
  }
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
  fireEvent.click(await screen.findByText("Iniciar verificação"));
  fireEvent.click(await screen.findByText("Gerar plano de correção"));
  await screen.findByText(/Fase 00 — Atualizações do sistema/);
}

beforeEach(() => {
  sessionStorage.clear();
  apiFetchMock.mockClear();
  detectedSudoUsers = undefined;
  sudoAccess = undefined;
  fakeLocation = { protocol: "http:", hostname: "localhost" };
});

/** Abre a seção recolhível da chave SSH da Fase 01 (se estiver fechada). */
function abrirSecaoChave() {
  if (screen.queryByLabelText(/Chave pública/)) return;
  fireEvent.click(screen.getByTestId("phase01-key-toggle"));
}

/** Abre "Detalhes e emergência" da Fase 01. */
function abrirDetalhes() {
  fireEvent.click(screen.getByRole("button", { name: /Detalhes e emergência/ }));
}

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

    // restaura a visão "Hardening aplicado" — NÃO a tela "Iniciar verificação"
    expect(await screen.findByText("Proteções aplicadas")).toBeInTheDocument();
    expect(screen.queryByText("Iniciar verificação")).not.toBeInTheDocument();

    // sem verificações no histórico, a jornada usa a última aplicação
    expect(screen.getByText("Quando a VPS chegou")).toBeInTheDocument();
    expect(screen.getByText("39")).toBeInTheDocument();
    expect(screen.getByText("Hoje")).toBeInTheDocument();
    expect(screen.getByText("75")).toBeInTheDocument();

    // caminho para avançar ao passo 4 sem re-rodar plano/dry-run/apply
    fireEvent.click(screen.getByRole("button", { name: /Continuar/ }));
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  /**
   * Validação real: fora do assistente a tela abria no último resultado salvo,
   * sem botão para verificar de novo — só "Continuar", que levava de volta; e
   * o link dizia "Voltar para Saúde da máquina" (etapa do assistente).
   */
  it("fora do assistente: resultado salvo oferece 'Verificar de novo' e fala de Segurança, não do assistente", async () => {
    apiFetchMock.mockImplementationOnce(async (path: string) => {
      if (path === "/api/security/history") {
        return {
          entries: [],
          firstIndex: 42,
          latestIndex: 86,
          applied: { appliedAt: "2026-09-29T10:20:00Z", beforeIndex: 42, beforeIndexSource: "internal", afterIndex: 86, afterIndexSource: "lynis" },
        };
      }
      throw new Error(`chamada inesperada: GET ${path}`);
    });
    const onNext = vi.fn();
    render(<SecurityStep mode="page" onNext={onNext} onBack={() => undefined} />);
    expect(await screen.findByText("Proteções aplicadas")).toBeInTheDocument();
    expect(screen.queryByText(/Saúde da máquina/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Continuar/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Voltar para Segurança/ }).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: /Verificar de novo/ }));
    await waitFor(() => {
      const calls = apiFetchMock.mock.calls.map(([p]) => String(p));
      expect(calls).toContain("/api/security/scan?fresh=1");
    });
  });

  it("no assistente o resultado salvo também oferece 'Verificar de novo'", async () => {
    apiFetchMock.mockImplementationOnce(async (path: string) => {
      if (path === "/api/security/history") {
        return {
          entries: [],
          firstIndex: 39,
          latestIndex: 75,
          applied: { appliedAt: "2026-08-21T10:20:00Z", beforeIndex: 39, beforeIndexSource: "lynis", afterIndex: 75, afterIndexSource: "lynis" },
        };
      }
      throw new Error(`chamada inesperada: GET ${path}`);
    });
    render(<SecurityStep onNext={() => undefined} onBack={() => undefined} />);
    expect(await screen.findByRole("button", { name: /Verificar de novo/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Voltar para Saúde da máquina/ })).toBeInTheDocument();
  });

  it("histórico sem apply → fluxo normal ('Iniciar verificação')", async () => {
    render(<SecurityStep onNext={() => undefined} onBack={() => undefined} />);
    expect(await screen.findByText("Iniciar verificação")).toBeInTheDocument();
    expect(screen.queryByText("Proteções aplicadas")).not.toBeInTheDocument();
  });
});

/**
 * Validação real: a tela de resultado mostrava só a ÚLTIMA aplicação — depois
 * de reaplicar a fase 07 o "antes" virou 79 (era 42), e o "depois" seguia 86
 * enquanto a verificação mais recente dizia 80. Somado às réguas diferentes
 * (42 era o índice interno; 79/86 são do Lynis), a tela perdia credibilidade.
 */
describe("SecurityStep — quando a nota não é do Lynis, a tela diz por quê", () => {
  it("mostra o motivo junto da nota", async () => {
    const base = apiFetchMock.getMockImplementation()!;
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith("/api/security/scan")) {
        return { report: { ...SCAN_REPORT, lynisNote: "O Lynis não concluiu nesta verificação" }, cached: false };
      }
      return base(path, init);
    });
    try {
      render(<SecurityStep onNext={() => undefined} />);
      fireEvent.click(await screen.findByText("Iniciar verificação"));
      expect(await screen.findByTestId("lynis-note")).toHaveTextContent(/não concluiu/);
    } finally {
      apiFetchMock.mockImplementation(base);
    }
  });
});

describe("SecurityStep — resultado conta a jornada inteira", () => {
  function historico(entries: Array<{ at: string; idx: number; src: "lynis" | "internal" }>, applied: { b: number; bs: "lynis" | "internal"; a: number; as: "lynis" | "internal" }) {
    apiFetchMock.mockImplementationOnce(async (path: string) => {
      if (path === "/api/security/history") {
        return {
          entries: entries.map((e, i) => ({ id: `s${i}`, at: e.at, kind: "scan", hardeningIndex: e.idx, hardeningIndexSource: e.src })),
          firstIndex: entries[0]?.idx ?? null,
          latestIndex: entries.at(-1)?.idx ?? null,
          applied: { appliedAt: "2026-09-29T20:00:00Z", beforeIndex: applied.b, beforeIndexSource: applied.bs, afterIndex: applied.a, afterIndexSource: applied.as },
        };
      }
      throw new Error(`chamada inesperada: GET ${path}`);
    });
  }

  it("mostra como a VPS chegou e como está hoje; réguas diferentes não viram '+N pontos'", async () => {
    historico(
      [
        { at: "2026-09-28T10:00:00Z", idx: 42, src: "internal" },
        { at: "2026-09-29T18:00:00Z", idx: 79, src: "lynis" },
        { at: "2026-09-29T20:30:00Z", idx: 86, src: "lynis" },
      ],
      { b: 79, bs: "lynis", a: 86, as: "lynis" },
    );
    render(<SecurityStep mode="page" onNext={() => undefined} onBack={() => undefined} />);
    const jornada = await screen.findByTestId("journey");
    expect(jornada).toHaveTextContent("Quando a VPS chegou");
    expect(jornada).toHaveTextContent("42");
    expect(jornada).toHaveTextContent("Hoje");
    expect(jornada).toHaveTextContent("86");
    expect(screen.queryByText(/\+44 pontos/)).not.toBeInTheDocument();
    expect(screen.getByTestId("journey-scales")).toHaveTextContent(/réguas diferentes/i);
    expect(screen.getByTestId("last-apply")).toHaveTextContent(/Última aplicação: 79 → 86 \(Lynis\), \+7 pontos/);
  });

  it("mesma régua do começo ao fim: mostra o ganho em pontos", async () => {
    historico(
      [
        { at: "2026-09-28T10:00:00Z", idx: 58, src: "lynis" },
        { at: "2026-09-29T20:30:00Z", idx: 86, src: "lynis" },
      ],
      { b: 58, bs: "lynis", a: 86, as: "lynis" },
    );
    render(<SecurityStep mode="page" onNext={() => undefined} onBack={() => undefined} />);
    expect(await screen.findByText(/\+28 pontos/)).toBeInTheDocument();
    expect(screen.queryByTestId("journey-scales")).not.toBeInTheDocument();
  });

  it("'Hoje' é a verificação MAIS RECENTE — se a nota caiu, a tela diz e explica por quê", async () => {
    historico(
      [
        { at: "2026-09-28T10:00:00Z", idx: 58, src: "lynis" },
        { at: "2026-09-29T20:30:00Z", idx: 86, src: "lynis" },
        { at: "2026-09-29T21:01:00Z", idx: 80, src: "lynis" },
      ],
      { b: 58, bs: "lynis", a: 86, as: "lynis" },
    );
    render(<SecurityStep mode="page" onNext={() => undefined} onBack={() => undefined} />);
    const jornada = await screen.findByTestId("journey");
    expect(jornada).toHaveTextContent("80");
    expect(screen.getByTestId("journey-drift")).toHaveTextContent(/atualizações de segurança/i);
    expect(screen.getByTestId("journey-drift")).toHaveTextContent(/86/);
  });
});

describe("SecurityStep — plano de correção", () => {
  it("cada fase pendente tem a ação principal 'Executar apenas esta fase' e a secundária 'Fazer manualmente'", async () => {
    await reachPlanStage();
    const executar = screen.getAllByRole("button", { name: /Executar apenas esta fase/ });
    expect(executar).toHaveLength(3); // fases 00, 01 e 02 pendentes
    const manual = screen.getAllByRole("button", { name: /Fazer manualmente/ });
    expect(manual).toHaveLength(3);
  });

  it("'Fazer manualmente' abre o modal com passo a passo copiável e 'Já executei — verificar de novo'", async () => {
    await reachPlanStage();
    fireEvent.click(screen.getAllByRole("button", { name: /Fazer manualmente/ })[0]!);

    const modal = await screen.findByRole("dialog");
    expect(modal).toHaveTextContent("Fazer manualmente — Fase 00");
    expect(await screen.findByText("sudo bash /opt/tws-panel/scripts/hardening/00-update.sh")).toBeInTheDocument();
    expect(screen.getByText(/Passo a passo — comandos exatos/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Já executei — verificar de novo/ })).toBeInTheDocument();

    // fecha pelo botão Fechar
    fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("'Já executei — verificar de novo' dispara scan fresco + novo plano", async () => {
    await reachPlanStage();
    fireEvent.click(screen.getAllByRole("button", { name: /Fazer manualmente/ })[0]!);
    await screen.findByRole("dialog");
    fireEvent.click(await screen.findByRole("button", { name: /Já executei — verificar de novo/ }));
    await waitFor(() => {
      const calls = apiFetchMock.mock.calls.map(([p]) => String(p));
      expect(calls).toContain("/api/security/scan?fresh=1");
    });
  });

  it("tutorial guiado de chave SSH está recolhido por padrão e expande sob demanda na Fase 01", async () => {
    await reachPlanStage();
    abrirSecaoChave();
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

  it("fase 01 diz em uma frase o que faz: desativa a senha do root", async () => {
    await reachPlanStage();
    expect(screen.getByText(/Fase 01 — desativar a senha do root/)).toBeInTheDocument();
    expect(screen.getByText(/ninguém entra como root com senha/i)).toBeInTheDocument();
  });

  it("campo de usuário não tem placeholder enganoso; a explicação fica no texto auxiliar", async () => {
    await reachPlanStage();
    const campo = screen.getByLabelText(/Usuário não-root criado na instalação/);
    // "deploy" em cinza dentro do campo parecia valor preenchido — foi removido
    expect(campo).not.toHaveAttribute("placeholder");
    expect(screen.getByText(/nome que você criou/i)).toBeInTheDocument();
    expect(screen.getByText(/ex\.: deploy/i)).toBeInTheDocument();
  });

  it("valida o formato da chave ao colar e mostra 'Sua chave parece válida ✅'", async () => {
    await reachPlanStage();
    abrirSecaoChave();
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

  it("Fase 01 com usuário e chave válidos habilita 'Executar apenas esta fase'", async () => {
    await reachPlanStage();
    const [, fase01Btn] = screen.getAllByRole("button", { name: /Executar apenas esta fase/ });
    expect(fase01Btn!.closest("button")).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Usuário não-root criado na instalação/), {
      target: { value: "kelvin" },
    });
    abrirSecaoChave();
    fireEvent.change(screen.getByLabelText(/Chave pública/), {
      target: {
        value:
          "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILSr6Jdm+iXYbln6BfkP2uCTKNO/eVi89lEjP7rH7dHN eu@notebook",
      },
    });
    expect(fase01Btn!.closest("button")).toBeEnabled();
  });
});

/**
 * A chave pública é OPCIONAL na Fase 01 — o script 01-user.sh trata --pubkey
 * como opcional (sem ela mantém o authorized_keys existente) e tem trava
 * anti-lockout própria: sem nenhuma chave instalada, não trava a senha do root.
 * Quem instalou a chave seguindo o README não deve ser obrigado a colá-la.
 */
describe("SecurityStep — Fase 01 com chave SSH opcional", () => {
  const CHAVE_VALIDA =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILSr6Jdm+iXYbln6BfkP2uCTKNO/eVi89lEjP7rH7dHN eu@notebook";

  /** Botão "Executar apenas esta fase" do card da Fase 01 (o segundo do plano). */
  function fase01Button() {
    return screen.getAllByRole("button", { name: /Executar apenas esta fase/ })[1]!;
  }

  function preencherUsuario(valor: string) {
    fireEvent.change(screen.getByLabelText(/Usuário não-root criado na instalação/), {
      target: { value: valor },
    });
  }

  function preencherChave(valor: string) {
    abrirSecaoChave();
    fireEvent.change(screen.getByLabelText(/Chave pública/), { target: { value: valor } });
  }

  it("usuário válido + chave VAZIA → botão da Fase 01 habilitado", async () => {
    await reachPlanStage();
    preencherUsuario("kelvin");
    expect(fase01Button()).toBeEnabled();
    // e a simulação de todas as fases também deixa de ser bloqueada
    expect(
      screen.getByRole("button", { name: /Simular todas as fases pendentes/ }),
    ).toBeEnabled();
  });

  it("usuário válido + chave de formato INVÁLIDO → botão continua desabilitado", async () => {
    await reachPlanStage();
    preencherUsuario("kelvin");
    preencherChave("nao-e-uma-chave");
    expect(fase01Button()).toBeDisabled();

    // limpar o campo volta a habilitar (vazio = reaproveita a chave do servidor)
    preencherChave("");
    expect(fase01Button()).toBeEnabled();
  });

  it("usuário vazio ou inválido → botão continua desabilitado, mesmo com chave válida", async () => {
    await reachPlanStage();
    expect(fase01Button()).toBeDisabled();

    preencherChave(CHAVE_VALIDA);
    expect(fase01Button()).toBeDisabled();

    preencherUsuario("root");
    expect(fase01Button()).toBeDisabled();

    preencherUsuario("kelvin");
    expect(fase01Button()).toBeEnabled();
  });

  it("o campo de chave se anuncia como opcional e diz que a chave do servidor é reaproveitada", async () => {
    await reachPlanStage();
    abrirSecaoChave();
    expect(screen.getByLabelText(/Chave pública.*opcional/i)).toBeInTheDocument();
    expect(screen.getByText(/já está no servidor, deixe em branco/i)).toBeInTheDocument();
  });

  it("com o formulário incompleto, a explicação aparece dentro do card da Fase 01, junto do botão", async () => {
    await reachPlanStage();
    const cardFase01 = fase01Button().closest("div.rounded-md.border")!;
    expect(cardFase01).toHaveTextContent(/Informe abaixo o usuário não-root/i);

    preencherUsuario("kelvin");
    expect(cardFase01).not.toHaveTextContent(/Informe abaixo o usuário não-root/i);
  });
});

/**
 * Dúvidas literais do dono do produto instalando numa VPS real:
 *  - "para que colar chave pública se agora eu digito a senha quando preciso?"
 *  - "e colar isso numa página http não é falha de segurança?"
 * As duas se respondem com TEXTO junto do campo — a lógica não muda.
 */
describe("SecurityStep — Fase 01 explica o que é a chave pública", () => {
  it("diz que a pública não é segredo e que a PRIVADA nunca é colada", async () => {
    await reachPlanStage();
    abrirSecaoChave();
    const paragrafo = screen.getByText(/chave pública não é segredo/i).closest("p")!;
    expect(paragrafo).toHaveTextContent(/é distribuída|distribuída|para ser distribuída/i);
    expect(paragrafo).toHaveTextContent(/chave privada/i);
    expect(paragrafo).toHaveTextContent(/sem \.pub/i);
  });

  it("nos detalhes, separa a chave SSH da senha do sudo e diz por que a fase exige as duas", async () => {
    await reachPlanStage();
    abrirDetalhes();
    const p = screen.getByText(/Não confunda/i).closest("p")!;
    expect(p).toHaveTextContent(/entra.*na VPS pelo SSH/i);
    expect(p).toHaveTextContent(/autoriza.*comandos administrativos/i);
    expect(p).toHaveTextContent(/pelo menos uma chave instalada/i);
    expect(p).toHaveTextContent(/sem te trancar para fora/i);
  });

  it("sobre http: o aviso só aparece quando a página está sem proteção", async () => {
    await reachPlanStage();
    abrirDetalhes();
    expect(screen.queryByText(/não vaza nada útil/i)).not.toBeInTheDocument(); // túnel (localhost)
    cleanup();
    fakeLocation = { protocol: "http:", hostname: "203.0.113.10", port: "9001" };
    await reachPlanStage();
    abrirDetalhes();
    const p = screen.getByText(/não vaza nada útil/i).closest("p")!;
    expect(p).toHaveTextContent(/alterar/i);
    expect(p).toHaveTextContent(/túnel SSH/i);
  });

  it("o rótulo do campo deixa claro que é o conteúdo do arquivo .pub", async () => {
    await reachPlanStage();
    abrirSecaoChave();
    expect(screen.getByLabelText(/arquivo \.pub/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Chave pública.*opcional/i)).toBeInTheDocument();
  });
});

/**
 * Feedback de campo: o card da Fase 01 tinha oito parágrafos e o leigo não
 * descobria o principal — o que vai acontecer com a VPS DELE. Agora o card
 * mostra o estado lido pela varredura (o usuário tem senha? tem chave?) e o
 * resultado, e o resto fica recolhido.
 */
describe("SecurityStep — Fase 01 mostra o que vai acontecer", () => {
  const CHAVE =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILSr6Jdm+iXYbln6BfkP2uCTKNO/eVi89lEjP7rH7dHN eu@notebook";

  async function comAcesso(hasPassword: boolean, keyCount: number) {
    detectedSudoUsers = ["kelvin"];
    sudoAccess = { kelvin: { hasPassword, keyCount } };
    await reachPlanStage();
    return screen.getByTestId("phase01-status");
  }

  it("com senha e chave: diz que a senha do root SERÁ desativada", async () => {
    const status = await comAcesso(true, 1);
    expect(status).toHaveTextContent(/kelvin tem senha/);
    expect(status).toHaveTextContent(/1 chave SSH instalada/);
    expect(status).toHaveTextContent(/a senha do root será desativada/i);
    // a chave já está lá: a seção de chave fica recolhida
    expect(screen.queryByLabelText(/Chave pública/)).not.toBeInTheDocument();
  });

  it("sem chave: NÃO será desativada, nada muda no acesso, e a seção de instalar a chave já vem aberta", async () => {
    const status = await comAcesso(true, 0);
    expect(status).toHaveTextContent(/nenhuma chave SSH instalada/i);
    expect(status).toHaveTextContent(/não será desativada/i);
    expect(status).toHaveTextContent(/continua entrando com a senha/i);
    expect(screen.getByLabelText(/Chave pública/)).toBeInTheDocument();
    expect(screen.getByTestId("phase01-key-toggle")).toHaveTextContent(/Instalar minha chave SSH/);
  });

  it("colar uma chave válida muda o resultado para 'será desativada'", async () => {
    const status = await comAcesso(true, 0);
    fireEvent.change(screen.getByLabelText(/Chave pública/), { target: { value: CHAVE } });
    expect(status).toHaveTextContent(/a senha do root será desativada/i);
  });

  it("sem senha: NÃO será desativada, diz por quê e como corrigir", async () => {
    const status = await comAcesso(false, 1);
    expect(status).toHaveTextContent(/kelvin não tem senha/);
    expect(status).toHaveTextContent(/não será desativada/i);
    expect(status).toHaveTextContent(/sem sudo/i);
    expect(status).toHaveTextContent("sudo passwd kelvin");
  });

  it("sem dado da varredura para o usuário: não afirma nada, aponta a simulação", async () => {
    detectedSudoUsers = ["kelvin"];
    await reachPlanStage();
    const status = screen.getByTestId("phase01-status");
    expect(status).toHaveTextContent(/simulação mostra/i);
    expect(status).not.toHaveTextContent(/será desativada/i);
  });

  it("detalhes e emergência ficam recolhidos e explicam o console e a confirmação em 5 minutos", async () => {
    await comAcesso(true, 1);
    expect(screen.queryByText(/console/i)).not.toBeInTheDocument();
    abrirDetalhes();
    expect(screen.getByText(/console da sua hospedagem/i).closest("p")).toHaveTextContent(/kelvin/);
    expect(screen.getByText(/nova janela SSH/i).closest("p")).toHaveTextContent(/5 minutos/);
  });
});

/**
 * Visto em campo: o alerta de "teste seu acesso" da Fase 01 dizia que a fase
 * "criou o usuário kelvin" (ele já existia) e mandava testar com
 * `ssh kelvin@localhost` — pelo túnel, "localhost" é o computador do
 * operador, não a VPS. O comando de teste precisa apontar para a VPS.
 */
describe("SecurityStep — alerta de teste de acesso", () => {
  let base: Parameters<typeof apiFetchMock.mockImplementation>[0] | undefined;

  async function aguardandoConfirmacao(phase: "01" | "02", vpsAddress: string | null) {
    detectedSudoUsers = ["kelvin"];
    base = apiFetchMock.getMockImplementation()!;
    const original = base;
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/security/undo-access") {
        return {
          job: {
            id: "job-1",
            phase,
            phaseKey: "user",
            title: "Usuário não-root",
            dryRun: false,
            status: "rolled_back",
            createdAt: "",
            startedAt: null,
            finishedAt: "",
            steps: [],
            log: "[executor] operador não conseguiu entrar — desfazendo a fase agora (--rollback)",
            rollbackScheduled: false,
            rollbackDeadline: null,
            error: null,
          },
        };
      }
      if (path === "/api/security/apply" || path.startsWith("/api/security/jobs/")) {
        return {
          job: {
            id: "job-1",
            phase,
            phaseKey: phase === "01" ? "user" : "ssh",
            title: phase === "01" ? "Usuário não-root" : "Hardening de SSH",
            dryRun: false,
            status: "awaiting_confirmation",
            createdAt: "",
            startedAt: null,
            finishedAt: null,
            steps: [],
            log: "",
            rollbackScheduled: true,
            rollbackDeadline: new Date(Date.now() + 300_000).toISOString(),
            error: null,
            sshUser: "kelvin",
          },
        };
      }
      return original(path, init);
    });
    render(<SecurityStep onNext={() => undefined} vpsAddress={vpsAddress} />);
    fireEvent.click(await screen.findByText("Iniciar verificação"));
    fireEvent.click(await screen.findByText("Gerar plano de correção"));
    await screen.findByText(/Fase 00 — Atualizações do sistema/);
    const index = phase === "01" ? 1 : 2;
    fireEvent.click(screen.getAllByRole("button", { name: /Executar apenas esta fase/ })[index]!);
    return screen.findByTestId("access-test-alert");
  }

  afterEach(() => {
    if (base) apiFetchMock.mockImplementation(base);
    base = undefined;
  });

  it("pelo túnel: o comando de teste usa o IP da VPS, não localhost", async () => {
    const alerta = await aguardandoConfirmacao("01", "203.0.113.10");
    expect(alerta).toHaveTextContent("ssh kelvin@203.0.113.10");
    expect(alerta).not.toHaveTextContent("@localhost");
  });

  it("não afirma que a fase criou o usuário", async () => {
    const alerta = await aguardandoConfirmacao("01", "203.0.113.10");
    expect(alerta).not.toHaveTextContent(/criou/i);
    expect(alerta).toHaveTextContent(/senha do root foi desativada/i);
  });

  it("'Não consegui entrar' desfaz a fase no servidor e a tela diz o que aconteceu", async () => {
    await aguardandoConfirmacao("01", "203.0.113.10");
    fireEvent.click(screen.getByRole("button", { name: /Não consegui entrar — desfazer agora/ }));
    await waitFor(() => {
      const undo = apiFetchMock.mock.calls.find(([p]) => p === "/api/security/undo-access");
      expect(JSON.parse(String(undo?.[1]?.body))).toEqual({ jobId: "job-1" });
    });
    const quadro = await screen.findByTestId("run-failed");
    expect(quadro).toHaveTextContent(/Você desfez a fase "Usuário não-root"/);
    expect(quadro).toHaveTextContent(/configuração anterior foi restaurada/);
    expect(screen.queryByTestId("access-test-alert")).not.toBeInTheDocument();
  });

  it("sem o IP conhecido, pede para trocar pelo IP da VPS em vez de inventar", async () => {
    const alerta = await aguardandoConfirmacao("01", null);
    expect(alerta).toHaveTextContent("ssh kelvin@IP_DA_VPS");
    expect(alerta).toHaveTextContent(/troque IP_DA_VPS/i);
  });

  it("aberto pelo IP: usa o próprio endereço da página", async () => {
    fakeLocation = { protocol: "http:", hostname: "198.51.100.7", port: "9001" };
    const alerta = await aguardandoConfirmacao("01", null);
    expect(alerta).toHaveTextContent("ssh kelvin@198.51.100.7");
  });

});

/**
 * Visto em campo: sem --user, a fase 02 deixava o root entrar com chave e não
 * restringia quem entra por SSH. O wizard manda o mesmo usuário da fase 01.
 */
describe("SecurityStep — fase 02 recebe o usuário", () => {
  it("executar a fase 02 envia o usuário não-root junto", async () => {
    detectedSudoUsers = ["kelvin"];
    await reachPlanStage();
    fireEvent.click(screen.getAllByRole("button", { name: /Executar apenas esta fase/ })[2]!);
    await waitFor(() => {
      const apply = apiFetchMock.mock.calls.find(([p]) => p === "/api/security/apply");
      expect(apply).toBeDefined();
      expect(JSON.parse(String(apply![1]!.body))).toMatchObject({ phase: "02", sshUser: "kelvin" });
    });
  });
});

/**
 * Defeito de campo: a fase 02 foi recusada logo ao começar e a tela parecia
 * travada — o cabeçalho seguia "Fase 2 de N", o log mostrava a fase anterior
 * como "concluído" e o único sinal era uma faixa vermelha no topo.
 */
describe("SecurityStep — fase que falha na simulação", () => {
  let original: Parameters<typeof apiFetchMock.mockImplementation>[0] | undefined;

  afterEach(() => {
    if (original) apiFetchMock.mockImplementation(original);
    original = undefined;
  });

  async function simularComFalhaNa02() {
    detectedSudoUsers = ["kelvin"];
    original = apiFetchMock.getMockImplementation()!;
    const base = original;
    const { ApiRequestError } = await import("@/lib/api");
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/security/apply") {
        const body = JSON.parse(String(init?.body)) as { phase: string };
        if (body.phase === "02") throw new ApiRequestError(409, "Conflict", "o usuário só se aplica às fases 01 e 02");
        return { job: { ...jobFor(body.phase), status: "running" } };
      }
      if (path.startsWith("/api/security/jobs/")) {
        const phase = path.endsWith("-00") ? "00" : "01";
        return { job: { ...jobFor(phase), status: "success", log: `log da fase ${phase} concluída` } };
      }
      return base(path, init);
    });
    await reachPlanStage();
    fireEvent.click(screen.getByRole("button", { name: /Simular todas as fases pendentes/ }));
    return screen.findByTestId("run-failed");
  }

  function jobFor(phase: string) {
    return {
      id: `job-${phase}`,
      phase,
      phaseKey: "x",
      title: phase === "00" ? "Atualizações do sistema" : "Usuário não-root",
      dryRun: true,
      createdAt: "",
      startedAt: null,
      finishedAt: null,
      steps: [],
      log: "",
      rollbackScheduled: false,
      rollbackDeadline: null,
      error: null,
    };
  }

  it("diz em qual fase parou, por quê, e que nada foi alterado", async () => {
    const quadro = await simularComFalhaNa02();
    expect(quadro).toHaveTextContent(/simulação parou na Fase 02 — Hardening de SSH/i);
    expect(quadro).toHaveTextContent(/o usuário só se aplica às fases 01 e 02/);
    expect(quadro).toHaveTextContent(/Nada foi alterado no servidor/i);
    expect(screen.getByText(/Parou na Fase 02/)).toBeInTheDocument();
  });

  it("não deixa o log da fase anterior na tela como se fosse o atual", async () => {
    await simularComFalhaNa02();
    expect(screen.queryByText(/Log em tempo real — Usuário não-root/)).not.toBeInTheDocument();
  });

  it("tentar de novo tira o quadro de falha e roda a simulação desde a primeira fase", async () => {
    await simularComFalhaNa02();
    const antes = apiFetchMock.mock.calls.filter(([p]) => p === "/api/security/apply").length;
    fireEvent.click(screen.getByRole("button", { name: /Tentar a simulação de novo/ }));
    await waitFor(() => {
      const applies = apiFetchMock.mock.calls.filter(([p]) => p === "/api/security/apply").slice(antes);
      expect(JSON.parse(String(applies[0]?.[1]?.body))).toMatchObject({ phase: "00", dryRun: true });
    });
    // falha de novo na 02 (o mock continua recusando) — e o quadro volta
    expect(await screen.findByTestId("run-failed")).toBeInTheDocument();
  });

  it("oferece tentar de novo (a simulação inteira) e voltar ao plano", async () => {
    await simularComFalhaNa02();
    expect(screen.getByRole("button", { name: /Tentar a simulação de novo/ })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /Voltar ao plano/ }));
    expect(await screen.findByText(/Plano de correção/)).toBeInTheDocument();
  });
});

/**
 * Validação real: o resultado dizia só "ainda há 1 finding crítico — alguns
 * exigem ação manual (ex.: containers Docker)", sem dizer QUAL — e o exemplo
 * já não valia (os containers do próprio painel passaram a ser risco aceito).
 */
describe("SecurityStep — resultado nomeia o que ficou crítico", () => {
  let original: Parameters<typeof apiFetchMock.mockImplementation>[0] | undefined;

  afterEach(() => {
    if (original) apiFetchMock.mockImplementation(original);
    original = undefined;
  });

  it("lista o título de cada item crítico que ficou reprovado", async () => {
    detectedSudoUsers = ["kelvin"];
    original = apiFetchMock.getMockImplementation()!;
    const base = original;
    let applied = false;
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/security/apply") {
        const body = JSON.parse(String(init?.body)) as { phase: string; dryRun: boolean };
        if (!body.dryRun) applied = true;
        return { job: { id: `j-${body.phase}`, phase: body.phase, title: "Fase", status: "running", steps: [], log: "", dryRun: body.dryRun, rollbackScheduled: false, rollbackDeadline: null, error: null } };
      }
      if (path.startsWith("/api/security/jobs/")) {
        return { job: { id: "j", phase: "00", title: "Fase", status: "success", steps: [], log: "", dryRun: true, rollbackScheduled: false, rollbackDeadline: null, error: null } };
      }
      if (path.startsWith("/api/security/scan") && applied) {
        return {
          report: {
            ...SCAN_REPORT,
            hardeningIndex: 86,
            hardeningIndexSource: "lynis",
            checks: [
              { id: "ssh.root-login", phase: "02", title: "Login de root via SSH desabilitado", severity: "critical", status: "fail", description: "", remediation: "" },
              { id: "firewall.ufw-active", phase: "03", title: "UFW ativo", severity: "critical", status: "pass", description: "", remediation: "" },
              { id: "audit.aide-baseline", phase: "06", title: "Baseline AIDE", severity: "warning", status: "fail", description: "", remediation: "" },
            ],
            summary: { total: 3, pass: 1, fail: 2, unknown: 0, critical: 1, warning: 1 },
          },
          cached: false,
        };
      }
      return base(path, init);
    });
    await reachPlanStage();
    fireEvent.click(screen.getByRole("button", { name: /Simular todas as fases pendentes/ }));
    // o fim da simulação ainda re-renderiza o bloco: clicar no botão já estável
    await screen.findByRole("button", { name: /Aplicar de verdade/ });
    await new Promise((r) => setTimeout(r, 50));
    fireEvent.click(screen.getByRole("button", { name: /Aplicar de verdade/ }));
    const faixa = await screen.findByTestId("remaining-critical");
    expect(faixa).toHaveTextContent("Login de root via SSH desabilitado");
    expect(faixa).not.toHaveTextContent("UFW ativo");
    expect(faixa).not.toHaveTextContent("Baseline AIDE");
    expect(faixa).not.toHaveTextContent(/containers Docker/);
  });
});

/**
 * "Executar dry-run de todas as fases pendentes" não se explicava a um leigo
 * ("isso executa todas as fases? se eu clicar, o que acontece?"). O rótulo e a
 * linha ao lado dele precisam responder isso sem jargão.
 */
describe("SecurityStep — botão de simulação se explica", () => {
  it("rótulo sem jargão e explicação do que acontece ao clicar", async () => {
    await reachPlanStage();
    const botao = screen.getByRole("button", { name: /Simular todas as fases pendentes/ });
    expect(botao).toHaveTextContent(/dry-run/i); // o termo técnico fica entre parênteses

    const explicacao = screen.getByTestId("dry-run-explicacao");
    expect(explicacao).toHaveTextContent(/simulação.*de todas as fases pendentes, na ordem/i);
    expect(explicacao).toHaveTextContent(/Nada é alterado no servidor/i);
    expect(explicacao).toHaveTextContent(/terminal/i);
    expect(explicacao).toHaveTextContent(/sudo vai pedir a sua senha/i);
    expect(explicacao).toHaveTextContent(/aplicar de verdade/i);
  });

  it("a fase individual também avisa que começa por uma simulação", async () => {
    await reachPlanStage();
    const cardFase00 = screen
      .getAllByRole("button", { name: /Executar apenas esta fase/ })[0]!
      .closest("div.rounded-md.border")!;
    expect(cardFase00).toHaveTextContent(/Começa por uma.*simulação/i);
    expect(cardFase00).toHaveTextContent(/nada é alterado no servidor/i);
  });
});

/**
 * O nome do usuário não-root NÃO se digita às cegas: a varredura já descobre
 * quem é (`nonRootSudoUsers`), e cada instalação tem o seu — nunca há valor
 * fixo. O campo é preenchido/oferecido a partir dessa detecção, o operador
 * continua podendo editar, e o que ele escreveu nunca é sobrescrito.
 */
describe("SecurityStep — usuário não-root detectado pela varredura", () => {
  function campoUsuario(): HTMLInputElement {
    return screen.getByLabelText(/Usuário não-root criado na instalação/) as HTMLInputElement;
  }

  it("um único detectado preenche o campo e a UI diz que o nome veio do servidor", async () => {
    detectedSudoUsers = ["deploy"];
    await reachPlanStage();

    expect(campoUsuario().value).toBe("deploy");
    expect(screen.getByText(/detectado no servidor/i)).toBeInTheDocument();
    // e o formulário já nasce válido: nada a digitar para liberar a fase
    expect(screen.getAllByRole("button", { name: /Executar apenas esta fase/ })[1]!).toBeEnabled();
  });

  it("dois ou mais detectados são oferecidos para escolha e a escolha preenche o campo", async () => {
    detectedSudoUsers = ["deploy", "kelvin"];
    await reachPlanStage();

    // ambíguo: não escolhe sozinho — pergunta
    expect(campoUsuario().value).toBe("");
    expect(screen.getByText(/2 usuários/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "kelvin" }));
    expect(campoUsuario().value).toBe("kelvin");
    expect(screen.getAllByRole("button", { name: /Executar apenas esta fase/ })[1]!).toBeEnabled();

    // continua sendo possível digitar um nome fora da lista
    fireEvent.change(campoUsuario(), { target: { value: "outro" } });
    expect(campoUsuario().value).toBe("outro");
  });

  it("nenhum detectado mantém o comportamento atual: campo vazio com texto de ajuda", async () => {
    detectedSudoUsers = [];
    await reachPlanStage();

    expect(campoUsuario().value).toBe("");
    expect(screen.getByText(/nome que você criou/i)).toBeInTheDocument();
    expect(screen.queryByText(/detectado no servidor/i)).not.toBeInTheDocument();
  });

  it("relatório antigo (sem o campo) se comporta como 'nenhum detectado', sem quebrar", async () => {
    detectedSudoUsers = undefined; // relatório persistido antes da detecção existir
    await reachPlanStage();

    expect(campoUsuario().value).toBe("");
    expect(screen.getByText(/nome que você criou/i)).toBeInTheDocument();
    expect(screen.queryByText(/detectado no servidor/i)).not.toBeInTheDocument();
  });

  it("o que o operador digitou NÃO é sobrescrito por uma varredura posterior", async () => {
    await reachPlanStage(); // primeira varredura: nada detectado
    fireEvent.change(campoUsuario(), { target: { value: "kelvin" } });

    // agora o servidor passa a detectar outro nome e o operador revarre
    detectedSudoUsers = ["deploy"];
    fireEvent.click(screen.getAllByRole("button", { name: /Fazer manualmente/ })[0]!);
    await screen.findByRole("dialog");
    fireEvent.click(await screen.findByRole("button", { name: /Já executei — verificar de novo/ }));
    await waitFor(() => {
      const calls = apiFetchMock.mock.calls.map(([p]) => String(p));
      expect(calls).toContain("/api/security/scan?fresh=1");
    });

    expect(campoUsuario().value).toBe("kelvin"); // a escolha do operador manda
  });

  it("informa o nome ao wizard, para que o terminal possa citá-lo", async () => {
    detectedSudoUsers = ["deploy"];
    const onSshUserDetected = vi.fn();
    render(<SecurityStep onNext={() => undefined} onSshUserDetected={onSshUserDetected} />);
    fireEvent.click(await screen.findByText("Iniciar verificação"));
    fireEvent.click(await screen.findByText("Gerar plano de correção"));
    await screen.findByText(/Fase 00 — Atualizações do sistema/);

    await waitFor(() => expect(onSshUserDetected).toHaveBeenCalledWith("deploy"));
  });
});

/**
 * O usuário do terminal passou a ser escolha EXPLÍCITA do operador na
 * instalação (PAAS_TERMINAL_USER → configuredUser). Quando existe, ele é a
 * fonte primária do campo da Fase 01; a detecção da varredura vira fallback.
 */
describe("SecurityStep — usuário configurado na instalação", () => {
  function campoUsuario(): HTMLInputElement {
    return screen.getByLabelText(/Usuário não-root criado na instalação/) as HTMLInputElement;
  }

  async function reachPlanWith(configuredUser: string | null) {
    render(<SecurityStep onNext={() => undefined} configuredUser={configuredUser} />);
    fireEvent.click(await screen.findByText("Iniciar verificação"));
    fireEvent.click(await screen.findByText("Gerar plano de correção"));
    await screen.findByText(/Fase 00 — Atualizações do sistema/);
  }

  it("configuredUser preenche o campo e vence a detecção, dizendo de onde veio", async () => {
    detectedSudoUsers = ["deploy", "kelvin"];
    await reachPlanWith("kelvin");
    expect(campoUsuario().value).toBe("kelvin");
    expect(screen.getByText(/configuração da instalação/i)).toBeInTheDocument();
    // a detecção não disputa com a escolha explícita
    expect(screen.queryByText(/detectado no servidor/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/2 usuários/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId("configured-user-not-detected")).not.toBeInTheDocument();
  });

  it("vence até um único detectado diferente — sem adivinhar outro nome", async () => {
    detectedSudoUsers = ["deploy"];
    await reachPlanWith("kelvin");
    expect(campoUsuario().value).toBe("kelvin");
  });

  it("configurado mas NÃO encontrado no grupo sudo: aviso claro, sem bloquear", async () => {
    detectedSudoUsers = ["deploy"];
    await reachPlanWith("kelvin");
    const aviso = screen.getByTestId("configured-user-not-detected");
    expect(aviso).toHaveTextContent(/kelvin/);
    expect(aviso).toHaveTextContent(/sudo/);
    expect(aviso).toHaveTextContent("usermod -aG sudo kelvin");
    // não bloqueia: a fase continua habilitada com o nome configurado
    expect(screen.getAllByRole("button", { name: /Executar apenas esta fase/ })[1]!).toBeEnabled();
  });

  it("relatório antigo (sem detecção): não afirma que o usuário está ausente", async () => {
    detectedSudoUsers = undefined;
    await reachPlanWith("kelvin");
    expect(campoUsuario().value).toBe("kelvin");
    expect(screen.queryByTestId("configured-user-not-detected")).not.toBeInTheDocument();
  });

  it("sem configuração (legado ou root): a detecção continua valendo", async () => {
    detectedSudoUsers = ["deploy"];
    await reachPlanWith(null);
    expect(campoUsuario().value).toBe("deploy");
    expect(screen.getByText(/detectado no servidor/i)).toBeInTheDocument();
    cleanup();

    // "root" não é um usuário não-root válido: não vira fonte do campo
    await reachPlanWith("root");
    expect(campoUsuario().value).toBe("deploy");
    expect(screen.queryByText(/configuração da instalação/i)).not.toBeInTheDocument();
  });

  it("o que o operador digitou não é sobrescrito quando a configuração chega depois", async () => {
    const { rerender } = render(<SecurityStep onNext={() => undefined} configuredUser={null} />);
    fireEvent.click(await screen.findByText("Iniciar verificação"));
    fireEvent.click(await screen.findByText("Gerar plano de correção"));
    await screen.findByText(/Fase 00 — Atualizações do sistema/);
    fireEvent.change(campoUsuario(), { target: { value: "outro" } });

    rerender(<SecurityStep onNext={() => undefined} configuredUser="kelvin" />);
    expect(campoUsuario().value).toBe("outro");
  });
});

/**
 * No modo senha, a varredura e as fases dependem do sudo no terminal. Quando
 * ele não executa nada (senha errada 3x, usuário sem sudo, tempo esgotado), o
 * servidor responde 424 `sudo_elevation_failed` com uma mensagem acionável —
 * que precisa chegar inteira ao operador, não virar "falha genérica".
 */
describe("SecurityStep — falha de elevação (sudo)", () => {
  const MSG =
    "o sudo recusou a senha 3 vezes. Nada foi executado como root. Confira a senha do usuário do terminal e rode de novo.";

  it("varredura com 424 sudo_elevation_failed: mensagem do servidor visível e ação de tentar de novo", async () => {
    const { ApiRequestError } = await import("@/lib/api");
    const base = apiFetchMock.getMockImplementation()!;
    let falhar = true;
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (falhar && path.startsWith("/api/security/scan")) {
        const err = new ApiRequestError(424, "Failed Dependency", MSG);
        Object.assign(err, { data: { code: "sudo_elevation_failed" } });
        throw err;
      }
      return base(path, init);
    });
    try {
      render(<SecurityStep onNext={() => undefined} />);
      fireEvent.click(await screen.findByText("Iniciar verificação"));

      const bloco = await screen.findByTestId("sudo-elevation-error");
      expect(bloco).toHaveTextContent(/O sudo recusou a senha 3 vezes/);
      expect(bloco).toHaveTextContent(/Nada foi executado como root/);
      expect(bloco).toHaveTextContent(/verificação/i);
      expect(screen.queryByText("Falha ao executar a verificação.")).not.toBeInTheDocument();

      falhar = false;
      fireEvent.click(screen.getByRole("button", { name: /Tentar a verificação de novo/ }));
      await screen.findByText("Gerar plano de correção");
      expect(screen.queryByTestId("sudo-elevation-error")).not.toBeInTheDocument();
    } finally {
      apiFetchMock.mockImplementation(base);
    }
  });

  it("fase que falha pelo sudo mostra a mensagem, sem afirmar rollback", async () => {
    const base = apiFetchMock.getMockImplementation()!;
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/security/jobs/job-1") {
        return {
          job: {
            id: "job-1",
            phase: "00",
            phaseKey: "update",
            title: "Atualizações do sistema",
            dryRun: true,
            status: "failed",
            createdAt: "",
            startedAt: null,
            finishedAt: null,
            steps: [],
            log: "",
            rollbackScheduled: false,
            rollbackDeadline: null,
            error: "tempo esgotado aguardando a senha do sudo. Nada foi executado como root.",
          },
        };
      }
      return base(path, init);
    });
    try {
      await reachPlanStage();
      fireEvent.click(screen.getAllByRole("button", { name: /Executar apenas esta fase/ })[0]!);
      const bloco = await screen.findByTestId("sudo-elevation-error");
      expect(bloco).toHaveTextContent(/Atualizações do sistema/);
      expect(bloco).toHaveTextContent(/Tempo esgotado aguardando a senha do sudo/);
      expect(screen.queryByText(/O rollback foi executado/)).not.toBeInTheDocument();
    } finally {
      apiFetchMock.mockImplementation(base);
    }
  });
});
