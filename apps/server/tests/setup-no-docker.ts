/**
 * setup-no-docker.ts — nenhum teste do servidor fala com o proxy de verdade.
 *
 * Criar projeto e mexer em domínio recarregam o Caddy na hora (página "site
 * em configuração" antes do primeiro deploy). Com o motor real, isso subiria
 * um container Caddy nas portas 80/443 da máquina que roda os testes. Teste
 * que quer ver a chamada troca `engine.syncCaddy` pelo seu próprio mock.
 *
 * Nem o docker CLI: o `node:child_process` de todos os arquivos manda os comandos `docker` ao dublê de
 * helpers/docker-duble.ts (anota e responde "daemon fora do ar"; nenhum processo é criado). git, sh e o resto rodam
 * de verdade, e o docker falso que um teste põe no PATH segue sendo dele. Teste que mocka o child_process por conta
 * própria continua mandando no seu arquivo.
 */
import { beforeEach, vi } from "vitest";
import { CaddyManager } from "@paas/deploy";
import { proxyNetworkDefaults } from "../src/services/proxy-network.js";
import { dockerDuble } from "./helpers/docker-duble.js";

vi.mock("node:child_process", async (importOriginal) => {
  const { childProcessComDuble } = await import("./helpers/docker-duble.js");
  return childProcessComDuble(await importOriginal<typeof import("node:child_process")>());
});
vi.mock("child_process", async (importOriginal) => {
  const { childProcessComDuble } = await import("./helpers/docker-duble.js");
  return childProcessComDuble(await importOriginal<typeof import("node:child_process")>());
});

// O coletor de métricas só roda em teste quando o teste liga (PAAS_METRICS=on): nenhum teste lê o /proc da máquina sem querer.
process.env.PAAS_METRICS ??= "off";

// Nem a paas-net: PAAS_PROXY_* vêm da leitura simulada (nada), nunca do Docker da máquina. Teste do proxy injeta o seu leitor.
proxyNetworkDefaults.inspect = async () => "{}";

beforeEach(() => {
  dockerDuble.reset();
  vi.spyOn(CaddyManager.prototype, "apply").mockResolvedValue(undefined);
});
