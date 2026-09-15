/**
 * Cofre de credenciais de LEITURA de repositórios privados.
 *
 * O token vale acesso ao código-fonte do operador: em repouso ele fica
 * CIFRADO (AES-256-GCM) com uma chave própria do cofre, em arquivo 0600
 * dentro do dataDir. Chave própria, e não o segredo de sessão: rotacionar um
 * não pode invalidar o outro.
 */
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CredentialVault } from "../src/services/credential-vault.js";

const TOKEN = "tok-fake-de-teste-leitura-0123456789";

let dir: string;
let cofre: CredentialVault;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-cofre-test-"));
  cofre = new CredentialVault(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("ciclo gravar / ler / apagar", () => {
  it("grava e lê a credencial em claro (uso interno do clone)", async () => {
    await cofre.set("p1", { username: "x-access-token", token: TOKEN });
    expect(await cofre.get("p1")).toEqual({ username: "x-access-token", token: TOKEN });
  });

  it("projeto sem credencial devolve null e has() false", async () => {
    expect(await cofre.get("nao-existe")).toBeNull();
    expect(await cofre.has("nao-existe")).toBe(false);
  });

  it("substitui a credencial de um projeto (última gravação vence)", async () => {
    await cofre.set("p1", { username: "x-access-token", token: TOKEN });
    await cofre.set("p1", { username: "outro", token: "token-novo-9999" });
    expect(await cofre.get("p1")).toEqual({ username: "outro", token: "token-novo-9999" });
  });

  it("apaga a credencial e informa se havia algo para apagar", async () => {
    await cofre.set("p1", { username: "x-access-token", token: TOKEN });
    expect(await cofre.remove("p1")).toBe(true);
    expect(await cofre.get("p1")).toBeNull();
    expect(await cofre.remove("p1")).toBe(false);
  });

  it("credenciais de projetos diferentes não se misturam", async () => {
    await cofre.set("p1", { username: "u1", token: "token-do-p1" });
    await cofre.set("p2", { username: "u2", token: "token-do-p2" });
    await cofre.remove("p1");
    expect(await cofre.get("p1")).toBeNull();
    expect(await cofre.get("p2")).toEqual({ username: "u2", token: "token-do-p2" });
  });
});

describe("informação pública (nunca o valor)", () => {
  it("info() diz que existe e dá só os 4 últimos caracteres como dica", async () => {
    await cofre.set("p1", { username: "x-access-token", token: TOKEN });
    const info = await cofre.info("p1");
    expect(info.configured).toBe(true);
    expect(info.hint).toBe(TOKEN.slice(-4));
    expect(info.username).toBe("x-access-token");
    expect(info.updatedAt).toBeTruthy();
    expect(JSON.stringify(info)).not.toContain(TOKEN);
  });

  it("info() de projeto sem credencial é tudo vazio", async () => {
    expect(await cofre.info("p9")).toEqual({
      configured: false,
      hint: null,
      username: null,
      updatedAt: null,
    });
  });
});

describe("cifragem em repouso", () => {
  it("o token não aparece em texto puro no arquivo do cofre", async () => {
    await cofre.set("p1", { username: "x-access-token", token: TOKEN });
    const bruto = await readFile(path.join(dir, "credentials.json"), "utf8");
    expect(bruto).not.toContain(TOKEN);
    expect(bruto).not.toContain("x-access-token");
  });

  it("nonce único por gravação: o mesmo valor gravado duas vezes gera cifras diferentes", async () => {
    await cofre.set("p1", { username: "u", token: TOKEN });
    const ler = async () =>
      (
        JSON.parse(await readFile(path.join(dir, "credentials.json"), "utf8")) as {
          credentials: { iv: string; data: string }[];
        }
      ).credentials[0]!;
    const primeira = await ler();
    await cofre.set("p1", { username: "u", token: TOKEN });
    const segunda = await ler();
    expect(primeira.iv).not.toBe(segunda.iv);
    expect(primeira.data).not.toBe(segunda.data);
  });

  it("texto cifrado adulterado é REJEITADO (tag de autenticação verificada), não devolve lixo", async () => {
    await cofre.set("p1", { username: "u", token: TOKEN });
    const arquivo = path.join(dir, "credentials.json");
    const conteudo = JSON.parse(await readFile(arquivo, "utf8")) as {
      credentials: { data: string; tag: string }[];
    };
    const registro = conteudo.credentials[0]!;
    const cifra = Buffer.from(registro.data, "base64");
    cifra.writeUInt8(cifra.readUInt8(0) ^ 0xff, 0);
    registro.data = cifra.toString("base64");
    await writeFile(arquivo, JSON.stringify(conteudo));

    const outro = new CredentialVault(dir);
    await expect(outro.get("p1")).rejects.toThrow(/credencial/i);
  });

  it("tag de autenticação adulterada também é rejeitada", async () => {
    await cofre.set("p1", { username: "u", token: TOKEN });
    const arquivo = path.join(dir, "credentials.json");
    const conteudo = JSON.parse(await readFile(arquivo, "utf8")) as {
      credentials: { data: string; tag: string }[];
    };
    const registro = conteudo.credentials[0]!;
    const tag = Buffer.from(registro.tag, "base64");
    tag.writeUInt8(tag.readUInt8(0) ^ 0xff, 0);
    registro.tag = tag.toString("base64");
    await writeFile(arquivo, JSON.stringify(conteudo));

    await expect(new CredentialVault(dir).get("p1")).rejects.toThrow(/credencial/i);
  });

  it("arquivos do cofre e da chave são 0600", async () => {
    await cofre.set("p1", { username: "u", token: TOKEN });
    for (const nome of ["credentials.json", "credentials-key"]) {
      const st = await stat(path.join(dir, nome));
      expect(st.mode & 0o777, nome).toBe(0o600);
    }
  });
});

describe("chave do cofre", () => {
  it("sobrevive a um restart: outra instância lê o mesmo arquivo e decifra", async () => {
    await cofre.set("p1", { username: "x-access-token", token: TOKEN });
    const chaveAntes = await readFile(path.join(dir, "credentials-key"), "utf8");

    const depoisDoRestart = new CredentialVault(dir);
    expect(await depoisDoRestart.get("p1")).toEqual({
      username: "x-access-token",
      token: TOKEN,
    });
    expect(await readFile(path.join(dir, "credentials-key"), "utf8")).toBe(chaveAntes);
  });

  it("é um arquivo PRÓPRIO — rotacionar o segredo de sessão não invalida o cofre", async () => {
    // O segredo de sessão (session-secret) é outro arquivo, com outro ciclo de
    // vida. Aqui ele é trocado e o cofre segue funcionando.
    await writeFile(path.join(dir, "session-secret"), "aa".repeat(32) + "\n", { mode: 0o600 });
    await cofre.set("p1", { username: "u", token: TOKEN });
    await writeFile(path.join(dir, "session-secret"), "bb".repeat(32) + "\n", { mode: 0o600 });
    expect(await new CredentialVault(dir).get("p1")).toEqual({ username: "u", token: TOKEN });
  });

  it("credencial cifrada com OUTRA chave não é decifrada silenciosamente", async () => {
    await cofre.set("p1", { username: "u", token: TOKEN });
    const chave = path.join(dir, "credentials-key");
    await chmod(chave, 0o600);
    await writeFile(chave, "cc".repeat(32) + "\n", { mode: 0o600 });
    await expect(new CredentialVault(dir).get("p1")).rejects.toThrow(/credencial/i);
  });
});
