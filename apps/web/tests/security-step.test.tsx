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

/**
 * Usuários não-root com sudo que a varredura devolve NESTA execução de teste.
 * `undefined` reproduz um relatório antigo, persistido antes de a detecção
 * existir — o campo é opcional no contrato e a UI deve tratá-lo como lista
 * vazia. Cada teste ajusta o valor antes de chegar ao plano.
 */
let detectedSudoUsers: string[] | undefined;

const apiFetchMock = vi.fn(async (path: string, init?: RequestInit) => {
  if (path === "/api/security/history") return HISTORY_EMPTY;
  if (path.startsWith("/api/security/scan")) {
    const report: SecurityScanReport = detectedSudoUsers
      ? { ...SCAN_REPORT, nonRootSudoUsers: detectedSudoUsers }
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
  fireEvent.click(await screen.findByText("Iniciar varredura"));
  fireEvent.click(await screen.findByText("Gerar plano de correção"));
  await screen.findByText(/Fase 00 — Atualizações do sistema/);
}

beforeEach(() => {
  sessionStorage.clear();
  apiFetchMock.mockClear();
  detectedSudoUsers = undefined;
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

  it("o campo de chave se anuncia como opcional e explica que a chave do servidor é reaproveitada", async () => {
    await reachPlanStage();
    expect(screen.getByLabelText(/Chave pública.*opcional/i)).toBeInTheDocument();
    expect(screen.getByText(/pode deixar em branco/i)).toBeInTheDocument();
    expect(screen.getByText(/chave que já está no servidor/i)).toBeInTheDocument();
  });

  it("avisa, junto do campo, que sem nenhuma chave instalada a senha do root NÃO é travada", async () => {
    await reachPlanStage();
    expect(screen.getByText(/não vai travar a senha do root/i)).toBeInTheDocument();
    expect(screen.getByText(/nunca causa lockout/i)).toBeInTheDocument();
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
    const paragrafo = screen.getByText(/chave pública não é segredo/i).closest("p")!;
    expect(paragrafo).toHaveTextContent(/é distribuída|distribuída|para ser distribuída/i);
    expect(paragrafo).toHaveTextContent(/chave privada/i);
    expect(paragrafo).toHaveTextContent(/sem \.pub/i);
  });

  it("separa a chave SSH da senha do sudo e explica por que a fase precisa dela", async () => {
    await reachPlanStage();
    const p = screen.getByText(/não tem relação com a senha do sudo/i).closest("p")!;
    expect(p).toHaveTextContent(/entra.*na VPS pelo SSH/i);
    expect(p).toHaveTextContent(/autoriza.*comandos administrativos/i);
    expect(p).toHaveTextContent(/pelo menos uma chave instalada/i);
    expect(p).toHaveTextContent(/sem te trancar para fora/i);
  });

  it("sobre http: colar a pública não vaza nada; o risco é alteração no caminho", async () => {
    await reachPlanStage();
    const p = screen.getByText(/não vaza nada útil/i).closest("p")!;
    expect(p).toHaveTextContent(/alterar/i);
    expect(p).toHaveTextContent(/túnel SSH/i);
  });

  it("o rótulo do campo deixa claro que é o conteúdo do arquivo .pub", async () => {
    await reachPlanStage();
    expect(screen.getByLabelText(/arquivo \.pub/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Chave pública.*opcional/i)).toBeInTheDocument();
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
    fireEvent.click(await screen.findByRole("button", { name: /Já executei — revarrer/ }));
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
    fireEvent.click(await screen.findByText("Iniciar varredura"));
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
    fireEvent.click(await screen.findByText("Iniciar varredura"));
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
    fireEvent.click(await screen.findByText("Iniciar varredura"));
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
      fireEvent.click(await screen.findByText("Iniciar varredura"));

      const bloco = await screen.findByTestId("sudo-elevation-error");
      expect(bloco).toHaveTextContent(/O sudo recusou a senha 3 vezes/);
      expect(bloco).toHaveTextContent(/Nada foi executado como root/);
      expect(bloco).toHaveTextContent(/varredura/i);
      expect(screen.queryByText("Falha ao executar a varredura.")).not.toBeInTheDocument();

      falhar = false;
      fireEvent.click(screen.getByRole("button", { name: /Tentar a varredura de novo/ }));
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
