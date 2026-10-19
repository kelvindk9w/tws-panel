/**
 * static-site.ts — pasta de publicação de um site estático (HTML puro).
 *
 * A pasta do código NÃO é servida direto: ela traz .git (todo o histórico;
 * num repositório privado, o código inteiro ficaria baixável) e às vezes .env
 * com segredos. O site vai para o ar a partir de uma cópia sem nada oculto —
 * exceto .well-known, usado por verificações de domínio (security.txt, etc.).
 */
import { cp, lstat, realpath, rm } from "node:fs/promises";
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

/**
 * Publica a saída de um build (`dist`, `out`) numa pasta CRIADA PELO PAINEL.
 *
 * O build roda com o `src` montado com escrita, então o repositório (ou uma
 * dependência npm) pode fazer `dist` apontar para qualquer pasta do host, e o
 * Docker resolveria o link ao montá-lo no nginx — publicando, por exemplo, o
 * código de todos os outros projetos (achado M8). Por isso: a saída precisa
 * ser uma pasta de verdade (não link) cujo caminho real fica dentro do código,
 * e o que vai ao ar é uma cópia sem nenhum link simbólico.
 */
export async function publishBuildOutput(src: string, outputDir: string, dest: string): Promise<void> {
  const target = path.resolve(src, outputDir);
  const info = await lstat(target).catch(() => null);
  if (!info) {
    throw new Error(`O build terminou, mas não gerou a pasta de saída "${outputDir}". Confira a pasta de saída do projeto.`);
  }
  if (info.isSymbolicLink()) {
    throw new Error(
      `A pasta de saída "${outputDir}" é um link simbólico. Por segurança o painel só publica uma pasta de verdade dentro do código do projeto.`,
    );
  }
  const root = await realpath(src);
  const real = await realpath(target);
  if (real === root || !real.startsWith(root + path.sep)) {
    throw new Error(
      `A pasta de saída "${outputDir}" fica fora do código do projeto (ou é o próprio código). Por segurança o painel só publica uma subpasta do código.`,
    );
  }
  if (!info.isDirectory()) {
    throw new Error(`A saída "${outputDir}" do build não é uma pasta.`);
  }
  await rm(dest, { recursive: true, force: true });
  await cp(real, dest, {
    recursive: true,
    filter: async (file) => !(await lstat(file)).isSymbolicLink(),
  });
}
