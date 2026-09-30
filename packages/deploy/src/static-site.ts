/**
 * static-site.ts — pasta de publicação de um site estático (HTML puro).
 *
 * A pasta do código NÃO é servida direto: ela traz .git (todo o histórico;
 * num repositório privado, o código inteiro ficaria baixável) e às vezes .env
 * com segredos. O site vai para o ar a partir de uma cópia sem nada oculto —
 * exceto .well-known, usado por verificações de domínio (security.txt, etc.).
 */
import { cp, rm } from "node:fs/promises";
import path from "node:path";

function publishable(src: string, file: string): boolean {
  const rel = path.relative(src, file);
  if (rel === "") return true;
  return rel.split(path.sep).every((part) => !part.startsWith(".") || part === ".well-known");
}

/** Recria `dest` com o conteúdo publicável de `src` (arquivo apagado no código sai do ar). */
export async function preparePublishDir(src: string, dest: string): Promise<void> {
  await rm(dest, { recursive: true, force: true });
  await cp(src, dest, { recursive: true, filter: (file) => publishable(src, file) });
}
