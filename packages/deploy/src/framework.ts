/**
 * framework.ts — reconhece o framework do app pelo código (aba Banco do projeto: quais comandos de banco
 * oferecer). Lê só dois arquivos da RAIZ do código: `composer.json` e `artisan`.
 *
 * Laravel = `laravel/framework` nas dependências do composer.json E o arquivo `artisan` na raiz. Um dos dois
 * sozinho não basta (um pacote que cita o Laravel, ou um `artisan` solto, não é o app).
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export type DetectedFramework = "laravel";

/** composer.json de verdade tem poucos KB. */
const MAX_COMPOSER_BYTES = 512 * 1024;

export async function detectFramework(srcDir: string): Promise<DetectedFramework | null> {
  try {
    const file = path.join(srcDir, "composer.json");
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_COMPOSER_BYTES) return null;
    const composer = JSON.parse(await readFile(file, "utf8")) as { require?: unknown };
    const requires = composer.require;
    if (!requires || typeof requires !== "object" || !("laravel/framework" in requires)) return null;
    const artisan = await stat(path.join(srcDir, "artisan"));
    return artisan.isFile() ? "laravel" : null;
  } catch {
    return null;
  }
}
