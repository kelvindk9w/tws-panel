/**
 * tmp.ts — apagar a pasta temporária de um teste sem corrida.
 *
 * O teardown pode chegar enquanto uma gravação terminou há pouco (ou o sistema de arquivos ainda está liberando
 * entradas): o `rm` recursivo vê a pasta mudar entre listar e apagar e falha com ENOTEMPTY/EBUSY. Tentar de novo
 * resolve a corrida do sistema de arquivos; a corrida com o código do painel se resolve ANTES, esperando o serviço
 * parar (`idle()`, `close()`, `stop()`), nunca aqui.
 */
import { rmSync } from "node:fs";
import { rm } from "node:fs/promises";

const RETRY = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as const;

export function removeDir(dir: string): Promise<void> {
  return rm(dir, RETRY);
}

export function removeDirSync(dir: string): void {
  rmSync(dir, RETRY);
}
