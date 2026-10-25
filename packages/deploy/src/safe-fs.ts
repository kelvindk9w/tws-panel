/**
 * safe-fs.ts — gravação em pastas que o projeto também consegue gravar.
 *
 * O painel grava `.env` e `.git/info/exclude` dentro de `src`. Um app invadido
 * troca esses nomes por links simbólicos (`.env -> /data/session-secret`) e o
 * painel, que roda com acesso ao /data, sobrescreveria um arquivo SEU (achado
 * A2). Aqui nada é gravado através de link simbólico.
 */
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";

/** Existe, é um diretório de verdade (não um link para um). */
export async function isRealDirectory(dir: string): Promise<boolean> {
  try {
    const info = await lstat(dir);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Existe e é um arquivo comum (não link, nem pasta, nem FIFO). */
export async function isRegularFile(file: string): Promise<boolean> {
  try {
    const info = await lstat(file);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Lê `file` por inteiro SEM seguir link simbólico no último nome (ELOOP se for link). */
export async function readFileNoFollow(file: string): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Lê no máximo `maxBytes` do começo de `file`, SÓ se for um arquivo comum: link
 * simbólico (no último nome), pasta, FIFO, dispositivo (/dev/zero) ou erro de
 * leitura devolvem undefined. É a leitura de tudo o que vem do repositório do
 * usuário na detecção e no deploy: o código dele não escolhe o que o painel lê
 * (um `.nvmrc -> /data/segredo` não vira texto no log) nem quanto.
 */
export async function readRegularFileLimited(file: string, maxBytes: number): Promise<string | undefined> {
  let handle;
  try {
    // O_NONBLOCK: abrir um FIFO sem escritor não pendura a detecção
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return undefined;
    const buffer = Buffer.alloc(Math.min(info.size, maxBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

/**
 * Grava `file` por inteiro SEM seguir link simbólico: escreve num arquivo
 * novo (`O_EXCL|O_NOFOLLOW`, nome aleatório ao lado) e o põe no lugar com
 * `rename`, que substitui o próprio link em vez de atravessá-lo.
 */
export async function writeFileNoFollow(file: string, content: string, mode: number): Promise<void> {
  const temp = `${file}.paas-${randomBytes(6).toString("hex")}`;
  const handle = await open(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode,
  );
  try {
    await handle.writeFile(content, "utf8");
    await handle.chmod(mode);
  } catch (err) {
    await handle.close();
    await rm(temp, { force: true });
    throw err;
  }
  await handle.close();
  try {
    await rename(temp, file);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}

/**
 * Acrescenta `text` ao fim de `file`, sem seguir link simbólico no último
 * nome. Devolve false (e não grava) se `file` for um link.
 */
export async function appendNoFollow(file: string, text: string): Promise<boolean> {
  try {
    const handle = await open(
      file,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      0o644,
    );
    try {
      await handle.writeFile(text, "utf8");
    } finally {
      await handle.close();
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOOP") return false;
    throw err;
  }
}
