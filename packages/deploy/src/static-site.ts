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
import { pathsOverlap } from "./ingest.js";

/**
 * Configuração do nginx para uma aplicação de página única: caminho que não é arquivo nem pasta
 * responde o index.html (as rotas do front-end abrem no link direto e no F5). Substitui o
 * default.conf da imagem; sem a opção ligada o painel não monta nada e o nginx se comporta como sempre.
 */
export const SPA_NGINX_CONF = [
  "# Gerado pelo TWS Panel (aplicação de página única)",
  "server {",
  "    listen 80;",
  "    listen [::]:80;",
  "    server_name _;",
  "    root /usr/share/nginx/html;",
  "    index index.html;",
  "    location / {",
  "        try_files $uri $uri/ /index.html;",
  "    }",
  "}",
  "",
].join("\n");

function publishable(src: string, file: string): boolean {
  const rel = path.relative(src, file);
  if (rel === "") return true;
  return rel.split(path.sep).every((part) => !part.startsWith(".") || part === ".well-known");
}

/**
 * A pasta de publicação é apagada e recriada a cada deploy. Se ela coincidir com
 * o código do usuário, ou ficar dentro dele (ou o contiver), o deploy apagaria
 * arquivos DELE. Recusa antes de tocar em qualquer coisa (achado A5).
 */
async function assertDestApartFromSource(src: string, dest: string): Promise<void> {
  const real = async (p: string) => {
    try {
      return await realpath(p);
    } catch {
      return path.resolve(p);
    }
  };
  if (pathsOverlap(await real(src), await real(dest))) {
    throw new Error(
      `A pasta de publicação (${dest}) coincide com a pasta do código (${src}), fica dentro dela ou a contém. ` +
        "O painel não apaga nem copia nada para não perder os seus arquivos. Faça um novo deploy depois de migrar o projeto " +
        "(o painel faz isso sozinho no deploy de projetos antigos) ou mova a pasta 'site' do código para outro lugar.",
    );
  }
}

/** Recria `dest` com o conteúdo publicável de `src` (arquivo apagado no código sai do ar). */
export async function preparePublishDir(src: string, dest: string): Promise<void> {
  await assertDestApartFromSource(src, dest);
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
 * e o que vai ao ar é uma cópia sem nenhum link simbólico e sem arquivo ou pasta
 * oculta (.env, .git...), como no HTML puro — exceto .well-known.
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
  await assertDestApartFromSource(src, dest);
  await rm(dest, { recursive: true, force: true });
  await cp(real, dest, {
    recursive: true,
    // sem link simbólico e sem arquivo oculto: um build que copia o .env (ou o .git) para dist/ não os publica
    filter: async (file) => publishable(real, file) && !(await lstat(file)).isSymbolicLink(),
  });
}
