/**
 * setup-token-capture.test.ts — regressão do bug do link do instalador:
 * abrir http://IP:9000/?token=XXX caía em "/" → guard redirecionava para
 * /setup e a query se perdia ANTES de qualquer useEffect rodar → campo de
 * token vazio. A captura agora acontece no CARREGAMENTO do módulo lib/api.ts
 * (antes do React renderizar), guardando o token na sessão e limpando a URL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  sessionStorage.clear();
  // força a reexecução do side effect de carregamento do módulo em cada teste
  vi.resetModules();
});

afterEach(() => {
  window.history.replaceState(null, "", "/");
  sessionStorage.clear();
});

describe("captura do setup token a partir da URL", () => {
  it("landing em /?token=... : token vai para a sessão e a URL é limpa no load do módulo", async () => {
    window.history.replaceState(null, "", "/?token=token-do-instalador");

    // importa DEPOIS de definir a URL — simula o carregamento real da página
    const api = await import("@/lib/api");

    expect(api.getSetupToken()).toBe("token-do-instalador");
    expect(sessionStorage.getItem("paas.setup-token")).toBe("token-do-instalador");
    // token removido da URL (não pode vazar em histórico/logs)
    expect(window.location.search).toBe("");
    expect(window.location.pathname).toBe("/");
  });

  it("initSetupToken() segue idempotente após a captura no load", async () => {
    window.history.replaceState(null, "", "/?token=token-do-instalador");
    const api = await import("@/lib/api");

    // chamadas seguintes (ex.: useEffect da SetupPage) não perdem o token
    expect(api.initSetupToken()).toBe("token-do-instalador");
    expect(api.getSetupToken()).toBe("token-do-instalador");
    expect(window.location.search).toBe("");
  });

  it("preserva outros parâmetros da query ao limpar o token", async () => {
    window.history.replaceState(null, "", "/?token=abc&origem=email");
    const api = await import("@/lib/api");

    expect(api.getSetupToken()).toBe("abc");
    expect(window.location.search).toBe("?origem=email");
  });

  it("sem ?token= na URL: nada é gravado e o token da sessão (se houver) é mantido", async () => {
    window.history.replaceState(null, "", "/setup");
    sessionStorage.setItem("paas.setup-token", "token-antigo");
    const api = await import("@/lib/api");

    expect(api.getSetupToken()).toBe("token-antigo");
    expect(window.location.search).toBe("");
  });
});
