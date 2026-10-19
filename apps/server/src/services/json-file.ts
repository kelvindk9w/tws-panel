/**
 * json-file.ts — "ler, alterar e gravar" um arquivo do diretório de dados sem
 * perder gravação de ninguém.
 *
 * O painel guarda tudo em arquivos JSON. O defeito que este módulo evita
 * apareceu em vários stores (auditoria, variáveis dos projetos, 2FA): a
 * leitura do estado atual acontecia FORA da fila que protegia a gravação.
 * Duas alterações paralelas partiam da mesma leitura e a última gravação
 * apagava a outra. Aqui a leitura, a alteração e a gravação de um arquivo
 * acontecem juntas, uma de cada vez, na mesma fila.
 *
 * Peças:
 *  - withFileLock(arquivo, fn): fila por arquivo (caminho absoluto), comum a
 *    todas as instâncias do processo — duas instâncias do mesmo store na
 *    mesma pasta também esperam uma pela outra;
 *  - writeFileAtomic: grava num temporário ao lado, fsync, e troca pelo
 *    rename. Quem lê vê o arquivo antigo inteiro ou o novo inteiro, nunca
 *    um pela metade — nem depois de queda de energia no meio;
 *  - createFileOnce: cria um arquivo SÓ se ele não existe (chaves de cifra:
 *    duas gravações na primeira vez nunca geram duas chaves);
 *  - JsonFile: junta tudo para um arquivo JSON. Não guarda cópia em
 *    memória: cada update() lê o disco dentro da fila. Arquivo ilegível (ou
 *    com formato que o store não reconhece) é guardado à parte, com o nome
 *    `<arquivo>.corrompido-<data>`, em vez de sobrescrito.
 *
 * Os temporários terminam em `.tmp`: o backup do painel já os ignora.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, link, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

const queues = new Map<string, Promise<unknown>>();
const ignore = (): undefined => undefined;

/** Roda `fn` sozinho para este arquivo: espera quem chegou antes e segura quem chega depois. */
export function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(file);
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.then(fn);
  const tail = run.then(ignore, ignore);
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

function tempName(file: string): string {
  return `${file}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
}

/** Grava o conteúdo num temporário com fsync; devolve o caminho dele. */
async function writeTemp(file: string, data: string | Buffer, mode: number): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = tempName(file);
  const handle = await open(tmp, "wx", mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } catch (err) {
    await handle.close();
    await unlink(tmp).catch(ignore);
    throw err;
  }
  await handle.close();
  // O modo exato mesmo com umask; sistema de arquivos que recusa chmod
  // (volume NTFS/CIFS) não impede a gravação — o open já pediu o modo.
  await chmod(tmp, mode).catch(ignore);
  return tmp;
}

/** fsync da pasta: o rename (ou o link) fica no disco, não só no cache. */
async function syncDir(dir: string): Promise<void> {
  try {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // alguns sistemas de arquivos não deixam abrir/sincronizar pasta: o rename já valeu
  }
}

/** Grava `file` inteiro de uma vez (temporário + fsync + rename). */
export async function writeFileAtomic(file: string, data: string | Buffer, opts: { mode?: number } = {}): Promise<void> {
  const tmp = await writeTemp(file, data, opts.mode ?? 0o600);
  try {
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(ignore);
    throw err;
  }
  await syncDir(path.dirname(file));
}

/**
 * Cria `file` com `data` só se ele ainda não existe. Devolve true se criou,
 * false se já havia um. O conteúdo aparece inteiro (temporário + link), e
 * nunca substitui um arquivo existente — nem de outro processo.
 */
export async function createFileOnce(file: string, data: string | Buffer, opts: { mode?: number } = {}): Promise<boolean> {
  const tmp = await writeTemp(file, data, opts.mode ?? 0o600);
  try {
    await link(tmp, file);
    await syncDir(path.dirname(file));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    await unlink(tmp).catch(ignore);
  }
}

/**
 * Chave de cifra guardada em hexa num arquivo próprio (0600). Lê; se não
 * existe, cria — dentro da fila do arquivo e com criação exclusiva, então
 * chamadas paralelas na primeira vez (e outro processo) recebem TODAS a
 * mesma chave. Erro de leitura que não seja "não existe" (E/S, permissão)
 * é LANÇADO: gerar outra chave por cima tornaria ilegível tudo o que a antiga
 * cifrou. Conteúdo que não é uma chave do tamanho certo é guardado à parte
 * (`<arquivo>.corrompido-<data>`) e uma chave nova é criada. Guarde a
 * promessa devolvida: ela é a "carga única" do store.
 */
export interface LoadKeyOptions {
  /** Aviso quando uma chave inválida é guardada à parte e substituída. */
  log?: (message: string) => void;
  /**
   * Descreve o que está cifrado com esta chave (ou null se nada). Com conteúdo
   * inválido E dados que dependem dela, a carga FALHA: uma chave nova os
   * tornaria ilegíveis para sempre.
   */
  dependents?: () => Promise<string | null>;
}

/** Erro de disco ao ler/gravar a chave, em português e dizendo o que conferir. */
function keyDiskError(file: string, action: "ler" | "gravar", err: unknown): Error {
  const code = (err as NodeJS.ErrnoException).code ?? "erro";
  return new Error(
    `Não consegui ${action} ${path.basename(file)} (${code}). Confira as permissões da pasta de dados do painel (/data no Docker): ` +
      "o dono do processo precisa poder ler e gravar nela. O painel não cria outra chave por cima para não perder o que está cifrado.",
    { cause: err },
  );
}

export function loadOrCreateKey(file: string, bytes: number, opts: LoadKeyOptions = {}): Promise<Buffer> {
  const read = async (): Promise<{ key: Buffer | null; present: boolean }> => {
    try {
      const hex = (await readFile(file, "utf8")).trim();
      const ok = hex.length === bytes * 2 && /^[0-9a-fA-F]+$/.test(hex);
      return { key: ok ? Buffer.from(hex, "hex") : null, present: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { key: null, present: false };
      throw keyDiskError(file, "ler", err);
    }
  };
  return withFileLock(file, async () => {
    const existing = await read();
    if (existing.key) return existing.key;
    const name = path.basename(file);
    if (existing.present) {
      const dependents = await opts.dependents?.();
      if (dependents) {
        throw new Error(
          `O arquivo ${name} existe, mas não tem uma chave válida, e há ${dependents} cifrado(s) com ela. ` +
            "O painel não gera outra chave sozinho (tudo isso ficaria ilegível). Restaure o arquivo a partir de um backup do painel " +
            "ou rode scripts/restaurar-painel.sh no servidor.",
        );
      }
    }
    const generated = randomBytes(bytes);
    const text = generated.toString("hex") + "\n";
    try {
      if (existing.present) {
        // conteúdo que não é chave (vazio, truncado, não-hexa): vai para o lado,
        // nunca é apagado — se era a chave de alguém, o dono ainda pode recuperá-la
        const aside = asideName(file);
        await rename(file, aside);
        opts.log?.(
          `Aviso: ${name} não tinha uma chave válida; guardei o conteúdo como ${path.basename(aside)} e criei uma chave nova. ` +
            "O que tiver sido cifrado com a chave antiga não poderá mais ser lido.",
        );
      }
      if (await createFileOnce(file, text)) return generated;
    } catch (err) {
      throw keyDiskError(file, "gravar", err);
    }
    // outro processo criou entre a leitura e a criação: vale a dele
    const other = await read();
    if (!other.key) throw new Error(`A chave ${name} está ilegível.`);
    return other.key;
  });
}

/** Data em formato seguro para nome de arquivo (2026-10-16T12-00-00-000Z). */
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Nome para guardar um arquivo ilegível à parte. Nunca o de um que já foi
 * guardado (o rename sobrescreveria a cópia anterior): no mesmo instante, o
 * nome ganha um número.
 */
function asideName(file: string): string {
  const base = `${file}.corrompido-${stamp()}`;
  let name = base;
  for (let i = 2; existsSync(name); i++) name = `${base}-${i}`;
  return name;
}

export interface LoadJsonOptions<T> {
  /** Valor quando o arquivo não existe (ou foi guardado à parte). */
  empty: () => T;
  /** Converte o JSON lido; null = formato que o store não reconhece. */
  parse: (raw: unknown) => T | null;
  /**
   * true: arquivo ilegível LANÇA erro (o arquivo não é mexido) — para dados
   * sem os quais seguir é perigoso (contas, lista de projetos, senha do
   * servidor de e-mail). false (padrão): o arquivo ruim é guardado à parte e
   * o store começa vazio.
   */
  strict?: boolean;
  /**
   * Só com `strict`: como recuperar ESTE arquivo (vai na mensagem de erro).
   * Padrão: restaurar uma cópia dele ou rodar scripts/restaurar-painel.sh.
   */
  recovery?: string;
  /** Aviso ao guardar um arquivo ilegível à parte. */
  log?: (message: string) => void;
}

/**
 * Carga de um arquivo JSON que NUNCA transforma "não consegui ler" em "está
 * vazio" para depois gravar por cima:
 *  - não existe (ENOENT): vale o vazio;
 *  - erro de disco (E/S, permissão): é lançado, o arquivo não é tocado;
 *  - JSON inválido ou formato desconhecido: guardado em
 *    `<arquivo>.corrompido-<data>` (ou lançado, se `strict`).
 * Roda na fila do arquivo; quem já está dentro da fila usa loadJsonInLock.
 */
export function loadJson<T>(file: string, opts: LoadJsonOptions<T>): Promise<T> {
  return withFileLock(file, () => loadJsonInLock(file, opts));
}

export async function loadJsonInLock<T>(file: string, opts: LoadJsonOptions<T>): Promise<T> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return opts.empty();
    throw err;
  }
  try {
    const value = opts.parse(JSON.parse(text));
    if (value !== null) return value;
  } catch {
    // JSON inválido: cai abaixo
  }
  if (opts.strict) {
    throw new Error(
      `O arquivo ${path.basename(file)} está ilegível e não foi alterado. ` +
        (opts.recovery ??
          "Restaure uma cópia dele (um backup do painel) ou rode scripts/restaurar-painel.sh no servidor. O painel não recomeça do zero sozinho para não perder os dados."),
    );
  }
  const aside = asideName(file);
  await rename(file, aside);
  opts.log?.(`${path.basename(file)} estava ilegível; guardei como ${path.basename(aside)} e comecei do zero.`);
  return opts.empty();
}

export interface JsonFileOptions<T> {
  /** Valor quando o arquivo não existe (ou foi guardado à parte). */
  empty: () => T;
  /**
   * Converte o JSON lido no valor do store. Devolver null = formato que o
   * store não reconhece: o arquivo é tratado como ilegível.
   */
  parse: (raw: unknown) => T | null;
  /** Modo do arquivo (padrão 0600). */
  mode?: number;
  /** Texto gravado (padrão: JSON com 2 espaços e quebra de linha no fim). */
  serialize?: (value: T) => string;
}

type ReadResult<T> = { value: T; unreadable: boolean };

export class JsonFile<T> {
  constructor(
    readonly file: string,
    private readonly opts: JsonFileOptions<T>,
  ) {}

  private async readRaw(): Promise<ReadResult<T>> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { value: this.opts.empty(), unreadable: false };
      throw err;
    }
    try {
      const value = this.opts.parse(JSON.parse(text));
      if (value !== null) return { value, unreadable: false };
    } catch {
      // JSON inválido: cai abaixo
    }
    return { value: this.opts.empty(), unreadable: true };
  }

  /**
   * Leitura (fora da fila). Como toda gravação é atômica, vê sempre uma
   * versão inteira. Arquivo ilegível lê como vazio, sem mexer nele.
   * Erro de disco que não seja "não existe" (permissão, E/S) é lançado.
   */
  async read(): Promise<T> {
    return (await this.readRaw()).value;
  }

  /**
   * Lê, aplica `change` e grava — tudo dentro da fila do arquivo. Se
   * `change` devolve o MESMO valor que recebeu, nada é gravado. Se `change`
   * lança, ou a gravação falha, o arquivo fica como estava e o erro chega
   * a quem chamou; a fila segue para o próximo.
   */
  update(change: (current: T) => T | Promise<T>): Promise<T> {
    return withFileLock(this.file, async () => {
      const { value, unreadable } = await this.readRaw();
      const next = await change(value);
      if (next === value) return next;
      if (unreadable) await rename(this.file, asideName(this.file));
      await this.write(next);
      return next;
    });
  }

  private async write(value: T): Promise<void> {
    const text = this.opts.serialize ? this.opts.serialize(value) : JSON.stringify(value, null, 2) + "\n";
    await writeFileAtomic(this.file, text, { mode: this.opts.mode ?? 0o600 });
  }
}
