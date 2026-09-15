/**
 * terminal-info.test.tsx — peças compartilhadas do terminal com usuário/modo:
 *  - useTerminalInfo: só consulta /api/terminal/info com o terminal liberado
 *    (mesmo bloqueio do WebSocket) e recusa resposta com formato estranho;
 *  - isInsecureTransport: a senha do sudo só trafega "segura" por https ou
 *    pelo túnel SSH (localhost/127.0.0.1/[::1]);
 *  - sudoElevationFailure: reconhece o 424 `sudo_elevation_failed` da API.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));
vi.mock("@/lib/api", async () => {
  const real = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return { ...real, apiFetch: apiFetchMock };
});

import { ApiRequestError } from "@/lib/api";
import {
  isInsecureTransport,
  isSudoJobError,
  sudoElevationFailure,
  useTerminalInfo,
} from "@/lib/terminal-info";

const INFO = {
  target: "host",
  user: "kelvin",
  configuredUser: "kelvin",
  rootMode: "senha",
  elevation: "senha",
  scheduledMonitoringRunsAsRoot: true,
};

function Probe({ enabled }: { enabled: boolean }) {
  const { info, unavailable } = useTerminalInfo(enabled);
  return (
    <p data-testid="probe">
      {info ? `${info.elevation}:${info.user}:${String(info.hostDockerAccess)}` : unavailable ? "indisponível" : "carregando"}
    </p>
  );
}

beforeEach(() => apiFetchMock.mockReset());
afterEach(() => cleanup());

describe("useTerminalInfo", () => {
  it("terminal bloqueado (sem token validado): NÃO chama a API", () => {
    render(<Probe enabled={false} />);
    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("probe")).toHaveTextContent("carregando");
  });

  it("liberado: consulta /api/terminal/info e expõe a resposta", async () => {
    apiFetchMock.mockResolvedValue(INFO);
    const { rerender } = render(<Probe enabled={false} />);
    rerender(<Probe enabled={true} />);
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("senha:kelvin:nao-verificado"));
    expect(apiFetchMock).toHaveBeenCalledWith("/api/terminal/info");
  });

  it("falha da API ou formato inesperado: indisponível, nunca um modo inventado", async () => {
    apiFetchMock.mockRejectedValueOnce(new Error("boom"));
    render(<Probe enabled={true} />);
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("indisponível"));
    cleanup();

    apiFetchMock.mockResolvedValueOnce({ report: {} });
    render(<Probe enabled={true} />);
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("indisponível"));
  });
});

describe("useTerminalInfo — acesso do usuário ao Docker do host", () => {
  it.each([
    ["sim", "sim"],
    ["nao", "nao"],
    ["nao-verificado", "nao-verificado"],
  ])("modo de usuário comum com %s: repassa", async (valor, esperado) => {
    apiFetchMock.mockResolvedValue({ ...INFO, hostDockerAccess: valor });
    render(<Probe enabled={true} />);
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent(`senha:kelvin:${esperado}`));
  });

  it("servidor antigo (campo ausente) ou valor estranho: nao-verificado — nunca 'nao' sem verificação", async () => {
    apiFetchMock.mockResolvedValueOnce(INFO);
    render(<Probe enabled={true} />);
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("senha:kelvin:nao-verificado"));
    cleanup();

    apiFetchMock.mockResolvedValueOnce({ ...INFO, elevation: "segundo-plano", rootMode: "segundo-plano", hostDockerAccess: "talvez" });
    render(<Probe enabled={true} />);
    await waitFor(() =>
      expect(screen.getByTestId("probe")).toHaveTextContent("segundo-plano:kelvin:nao-verificado"),
    );
  });

  it("sessões root e container de dev: não se aplica (null), mesmo que o servidor mande algo", async () => {
    apiFetchMock.mockResolvedValueOnce({
      ...INFO,
      user: "root",
      configuredUser: null,
      rootMode: null,
      elevation: "root-legado",
      hostDockerAccess: "sim",
    });
    render(<Probe enabled={true} />);
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("root-legado:root:null"));
  });
});

describe("isInsecureTransport", () => {
  it("http por IP ou domínio: inseguro", () => {
    expect(isInsecureTransport({ protocol: "http:", hostname: "203.0.113.10" })).toBe(true);
    expect(isInsecureTransport({ protocol: "http:", hostname: "painel.exemplo.com" })).toBe(true);
  });

  it("https em qualquer host: seguro", () => {
    expect(isInsecureTransport({ protocol: "https:", hostname: "203.0.113.10" })).toBe(false);
  });

  it("túnel SSH (localhost, 127.0.0.1, [::1]) em http: seguro", () => {
    for (const hostname of ["localhost", "127.0.0.1", "[::1]", "::1"]) {
      expect(isInsecureTransport({ protocol: "http:", hostname })).toBe(false);
    }
  });
});

describe("sudoElevationFailure", () => {
  it("reconhece o 424 sudo_elevation_failed (código no corpo, como o Fastify serializa)", () => {
    const err = new ApiRequestError(424, "Failed Dependency", "o sudo recusou a senha 3 vezes.", {
      code: "sudo_elevation_failed",
    });
    expect(sudoElevationFailure(err)).toBe("o sudo recusou a senha 3 vezes.");
    expect(sudoElevationFailure(new ApiRequestError(424, "sudo_elevation_failed", "x"))).toBe("x");
  });

  it("outros erros não são confundidos com falha do sudo", () => {
    expect(sudoElevationFailure(new ApiRequestError(500, "http_error", "falhou"))).toBeNull();
    expect(sudoElevationFailure(new Error("sudo"))).toBeNull();
  });

  it("isSudoJobError: erro de fase causado pelo sudo vs. erro comum de script", () => {
    expect(isSudoJobError("o sudo recusou a senha 3 vezes. Nada foi executado como root.")).toBe(true);
    expect(isSudoJobError("terminal indisponível (x). No modo senha (PAAS_ROOT_MODE=senha) ...")).toBe(true);
    expect(isSudoJobError("script 02-ssh.sh saiu com código 1")).toBe(false);
    expect(isSudoJobError(null)).toBe(false);
  });
});
