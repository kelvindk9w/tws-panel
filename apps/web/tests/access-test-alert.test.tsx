/**
 * access-test-alert.test.tsx — o alerta "teste seu acesso" das fases 01/02/03.
 *
 * Feedback da validação real:
 *  - "abra outra janela" confundia (janela do navegador? do terminal?);
 *  - faltava botão de copiar o comando;
 *  - faltava dizer POR QUE testar a cada fase — curto na tela, com detalhes
 *    para quem quiser expandir;
 *  - "Interromper" só parava a tela: quem não conseguiu entrar precisa de uma
 *    saída efetiva, que desfaça a fase agora.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessTestAlert } from "@/components/setup/AccessTestAlert";

afterEach(cleanup);

function renderAlert(overrides: Partial<Parameters<typeof AccessTestAlert>[0]> = {}) {
  const props = {
    phase: "02" as const,
    phaseTitle: "Hardening de SSH",
    user: "kelvin",
    host: "203-0-113-10.sslip.io",
    deadline: new Date(Date.now() + 300_000).toISOString(),
    busy: false,
    onConfirm: vi.fn(),
    onUndo: vi.fn(),
    ...overrides,
  };
  render(<AccessTestAlert {...props} />);
  return props;
}

describe("AccessTestAlert", () => {
  it("diz onde testar sem ambiguidade: o terminal do computador, não o navegador", () => {
    renderAlert();
    const alerta = screen.getByTestId("access-test-alert");
    expect(alerta).toHaveTextContent(/terminal do seu computador/i);
    expect(alerta).toHaveTextContent(/não o navegador/i);
    expect(alerta).toHaveTextContent(/sem fechar esta página/i);
  });

  it("mostra o comando com botão de copiar", () => {
    renderAlert();
    expect(screen.getByTestId("access-test-command")).toHaveTextContent("ssh kelvin@203-0-113-10.sslip.io");
    expect(screen.getByRole("button", { name: /Copiar/ })).toBeInTheDocument();
  });

  it("diz o que é dar certo", () => {
    renderAlert();
    expect(screen.getByTestId("access-test-alert")).toHaveTextContent(/kelvin@.*deu certo/i);
    expect(screen.getByTestId("access-test-alert")).toHaveTextContent(/exit/);
  });

  it("explica, curto, por que testar agora — e esconde o resto em 'Mais detalhes'", () => {
    renderAlert();
    const alerta = screen.getByTestId("access-test-alert");
    expect(alerta).toHaveTextContent(/desfazemos só esta fase/i);
    expect(screen.queryByText(/PowerShell/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Mais detalhes/ }));
    expect(screen.getByText(/PowerShell/)).toBeInTheDocument();
    expect(screen.getByText(/senha da chave/i)).toBeInTheDocument();
  });

  it("texto de cada fase diz o que mudou", () => {
    renderAlert({ phase: "01", phaseTitle: "Usuário não-root" });
    expect(screen.getByTestId("access-test-alert")).toHaveTextContent(/senha do root foi desativada/i);
    cleanup();
    renderAlert({ phase: "02" });
    expect(screen.getByTestId("access-test-alert")).toHaveTextContent(/só por chave.*só kelvin/i);
    cleanup();
    renderAlert({ phase: "03", phaseTitle: "Firewall (UFW)" });
    expect(screen.getByTestId("access-test-alert")).toHaveTextContent(/firewall foi ligado/i);
  });

  it("dois botões com consequência clara", () => {
    const props = renderAlert();
    fireEvent.click(screen.getByRole("button", { name: /Entrei — confirmar/ }));
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /Não consegui entrar — desfazer agora/ }));
    expect(props.onUndo).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /^Interromper$/ })).not.toBeInTheDocument();
  });

  it("enquanto confirma/desfaz, os botões ficam travados", () => {
    renderAlert({ busy: true });
    expect(screen.getByRole("button", { name: /Entrei — confirmar/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /desfazer agora/ })).toBeDisabled();
  });

  it("sem o IP conhecido, pede para trocar IP_DA_VPS", () => {
    renderAlert({ host: "IP_DA_VPS" });
    expect(screen.getByTestId("access-test-alert")).toHaveTextContent(/troque IP_DA_VPS/i);
  });

  it("sem usuário conhecido não inventa comando", () => {
    renderAlert({ user: null });
    expect(screen.queryByTestId("access-test-command")).not.toBeInTheDocument();
  });
});

/**
 * Validação real: o operador deixou o prazo acabar e o alerta ficou parado em
 * 0:00 com os botões ativos — sem dizer que o servidor estava desfazendo.
 */
describe("AccessTestAlert — prazo esgotado", () => {
  it("em 0:00 diz que o servidor está desfazendo a fase e trava os botões", () => {
    renderAlert({ deadline: new Date(Date.now() - 1_000).toISOString() });
    expect(screen.getByTestId("access-test-alert")).toHaveTextContent(/prazo acabou.*desfazendo esta fase/i);
    expect(screen.getByRole("button", { name: /Entrei — confirmar/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /desfazer agora/ })).toBeDisabled();
  });
});
