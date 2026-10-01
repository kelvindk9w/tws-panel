/**
 * setup-no-docker.ts — nenhum teste do servidor fala com o proxy de verdade.
 *
 * Criar projeto e mexer em domínio recarregam o Caddy na hora (página "site
 * em configuração" antes do primeiro deploy). Com o motor real, isso subiria
 * um container Caddy nas portas 80/443 da máquina que roda os testes. Teste
 * que quer ver a chamada troca `engine.syncCaddy` pelo seu próprio mock.
 */
import { beforeEach, vi } from "vitest";
import { CaddyManager } from "@paas/deploy";

beforeEach(() => {
  vi.spyOn(CaddyManager.prototype, "apply").mockResolvedValue(undefined);
});
