/**
 * password.ts — hash e verificação de senhas com argon2id (@node-rs/argon2).
 * A senha NUNCA é armazenada ou logada em claro.
 */
import { hash, verify } from "@node-rs/argon2";

/**
 * Hash pré-computado usado na verificação de usuários inexistentes, para que
 * o tempo de resposta do login não revele se a conta existe (timing attack).
 * Gerado com hash("dummy-password-para-timing") — o conteúdo não importa.
 */
let dummyHash: Promise<string> | null = null;

function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword("dummy-password-para-timing");
  return dummyHash;
}

/**
 * Gera o hash fictício já na inicialização: sem isso o PRIMEIRO pedido com
 * usuário inexistente depois do boot custava um hash a mais (diferença
 * mensurável). Chamado por app.ts; falha aqui é inofensiva (tenta de novo no
 * primeiro uso).
 */
export async function warmUpDummyHash(): Promise<void> {
  try {
    await getDummyHash();
  } catch {
    dummyHash = null;
  }
}

export async function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    // hash malformado/corrompido — trata como falha de verificação
    return false;
  }
}

/**
 * Verifica a senha contra o hash do usuário — ou contra um hash dummy quando o
 * usuário não existe, mantendo o tempo de resposta constante.
 */
export async function verifyPasswordTimingSafe(
  passwordHash: string | null,
  password: string,
): Promise<boolean> {
  if (passwordHash === null) {
    await verifyPassword(await getDummyHash(), password);
    return false;
  }
  return verifyPassword(passwordHash, password);
}
