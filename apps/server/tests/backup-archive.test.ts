/**
 * backup-archive.test.ts — o 7-Zip que monta e confere os .7z.
 *
 * Um 7zz de mentira (script Node) registra os argumentos e o que chegou pela
 * entrada padrão: a regra é que a senha NUNCA aparece nos argumentos (que
 * qualquer processo da máquina vê no `ps`) — ela vai pelo stdin.
 *
 * Com PAAS_TEST_7Z apontando para um 7zz de verdade, roda também um teste
 * real (criar cifrado, testar com a senha certa e errada, extrair).
 */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArchiveError, SevenZip, parseArchiveWarnings } from "../src/services/backup-archive.js";

let dir: string;
let fakeBin: string;
let logFile: string;

const FAKE = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, stdin: input }) + "\\n");
  const mode = process.env.FAKE_MODE || "ok";
  if (mode === "slow") return setTimeout(() => process.exit(0), 5000);
  if (mode === "crash") { process.stderr.write("ERROR: Data Error : arquivo.7z\\n"); process.exit(2); }
  if (mode === "warnbare") return process.exit(1);
  if (mode === "warn") {
    // saída do 7-Zip 24 com uma entrada que sumiu e um arquivo sem leitura (código 1)
    const inputs = args.filter((a) => a.startsWith("/") && !a.endsWith(".7z"));
    fs.writeFileSync(args.find((a) => a.endsWith(".7z")), "7z|aberto");
    process.stderr.write("\\nWARNING: errno=2 : No such file or directory\\n" + inputs[0] + "/sumiu.json\\n\\n");
    process.stderr.write("Scan WARNINGS for files and folders:\\n\\n" + inputs[0] + "/sumiu.json : errno=2 : No such file or directory\\n");
    process.stderr.write(inputs[0] + "/sub/trancado.key : errno=13 : Permission denied\\n----------------\\nScan WARNINGS: 2\\n");
    return process.exit(1);
  }
  const cmd = args[0];
  if (cmd === "a") {
    const archive = args.find((a) => a.endsWith(".7z"));
    fs.writeFileSync(archive, "7z|" + (args.includes("-p") ? "senha:" + input.trim() : "aberto"));
    return process.exit(0);
  }
  if (cmd === "t" || cmd === "x") {
    const archive = args.find((a) => a.endsWith(".7z"));
    const content = fs.readFileSync(archive, "utf8");
    const pw = content.startsWith("7z|senha:") ? content.slice(9) : null;
    if (pw !== null && input.trim() !== pw) {
      process.stdout.write("ERROR: Cannot open encrypted archive. Wrong password?\\n");
      return process.exit(2);
    }
    if (cmd === "x") {
      const out = args.find((a) => a.startsWith("-o")).slice(2);
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(out + "/extraido.txt", "ok");
    }
    return process.exit(0);
  }
  if (cmd === "i") return process.exit(0);
  process.exit(7);
});
`;

function calls(): Array<{ args: string[]; stdin: string }> {
  return readFile(logFile, "utf8").then((t) =>
    t
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { args: string[]; stdin: string }),
  ) as unknown as Array<{ args: string[]; stdin: string }>;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-7z-"));
  fakeBin = path.join(dir, "7zz");
  logFile = path.join(dir, "log.jsonl");
  await writeFile(fakeBin, FAKE);
  await chmod(fakeBin, 0o755);
  process.env.FAKE_LOG = logFile;
  process.env.FAKE_MODE = "ok";
});

afterEach(async () => {
  delete process.env.FAKE_MODE;
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("SevenZip (7zz de mentira)", () => {
  it("cifrado: senha pelo stdin, nunca nos argumentos; nomes cifrados (-mhe=on)", async () => {
    const z = new SevenZip({ bin: fakeBin });
    const archive = path.join(dir, "b.7z");
    await z.create(archive, [path.join(dir, "log.jsonl")], { password: "frase-secreta-longa" });
    const [call] = await calls();
    expect(call!.args).toContain("-mhe=on");
    expect(call!.args).toContain("-p");
    expect(call!.args.join(" ")).not.toContain("frase-secreta-longa");
    expect(call!.stdin).toBe("frase-secreta-longa\n");
  });

  it("sem senha: .7z comum, nada no stdin", async () => {
    const z = new SevenZip({ bin: fakeBin });
    await z.create(path.join(dir, "b.7z"), [dir], {});
    const [call] = await calls();
    expect(call!.args).not.toContain("-p");
    expect(call!.args).not.toContain("-mhe=on");
    expect(call!.stdin).toBe("");
  });

  it("testa e extrai com a senha certa; a errada vira wrong_password", async () => {
    const z = new SevenZip({ bin: fakeBin });
    const archive = path.join(dir, "b.7z");
    await z.create(archive, [dir], { password: "frase-secreta-longa" });
    await z.test(archive, "frase-secreta-longa");
    const err = await z.test(archive, "outra-senha-qualquer").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArchiveError);
    expect((err as ArchiveError).code).toBe("wrong_password");
    expect((err as ArchiveError).message).not.toContain("outra-senha-qualquer");
    const out = path.join(dir, "saida");
    await z.extract(archive, out, "frase-secreta-longa");
    expect(await readFile(path.join(out, "extraido.txt"), "utf8")).toBe("ok");
  });

  it("extrair só alguns caminhos (teste de restauração): passa os nomes depois do arquivo; sem a lista, nada muda", async () => {
    const z = new SevenZip({ bin: fakeBin });
    const archive = path.join(dir, "b.7z");
    await z.create(archive, [dir], {});
    await z.extract(archive, path.join(dir, "s1"), null, ["manifesto.json", "bancos"]);
    await z.extract(archive, path.join(dir, "s2"), null);
    const all = await calls();
    const only = all[1]!.args;
    expect(only.slice(only.indexOf(archive))).toEqual([archive, "manifesto.json", "bancos"]);
    const full = all[2]!.args;
    expect(full[full.length - 1]).toBe(archive);
  });

  it("sem senha num arquivo comum: passa -p vazio para nunca ficar esperando a senha", async () => {
    const z = new SevenZip({ bin: fakeBin });
    const archive = path.join(dir, "b.7z");
    await z.create(archive, [dir], {});
    await z.test(archive, null);
    const all = await calls();
    expect(all[1]!.args).toContain("-p");
    expect(all[1]!.stdin).toBe("");
  });

  it("arquivo corrompido e prazo esgotado", async () => {
    // o prazo curto só vale para o caso "slow"; no "crash" o processo precisa subir (com a máquina ocupada passa de 200 ms)
    const z = new SevenZip({ bin: fakeBin, timeoutMs: 200 });
    const zCrash = new SevenZip({ bin: fakeBin, timeoutMs: 30_000 });
    process.env.FAKE_MODE = "crash";
    const err = await zCrash.test(path.join(dir, "x.7z"), null).catch((e: unknown) => e);
    expect((err as ArchiveError).code).toBe("failed");
    expect((err as ArchiveError).message).toMatch(/Data Error/);
    process.env.FAKE_MODE = "slow";
    const slow = await z.test(path.join(dir, "x.7z"), null).catch((e: unknown) => e);
    expect((slow as ArchiveError).code).toBe("timeout");
  });

  it("código 1 (aviso: arquivo não lido ou que sumiu) ao criar é falha, com os arquivos no motivo", async () => {
    const z = new SevenZip({ bin: fakeBin });
    process.env.FAKE_MODE = "warn";
    const painel = path.join(dir, "painel");
    const err = await z.create(path.join(dir, "b.7z"), [painel], {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArchiveError);
    expect((err as ArchiveError).code).toBe("incomplete");
    expect((err as ArchiveError).message).toMatch(/2 arquivo\(s\)/);
    expect((err as ArchiveError).message).toContain("painel/sumiu.json (não encontrado)");
    expect((err as ArchiveError).message).toContain("painel/sub/trancado.key (sem permissão de leitura)");
    expect((err as ArchiveError).message).not.toContain(dir);
  });

  it("código 1 sem lista de arquivos ao criar também é falha; ao testar ou extrair segue valendo como antes", async () => {
    const z = new SevenZip({ bin: fakeBin });
    process.env.FAKE_MODE = "warnbare";
    const err = await z.create(path.join(dir, "b.7z"), [dir], {}).catch((e: unknown) => e);
    expect((err as ArchiveError).code).toBe("incomplete");
    expect((err as ArchiveError).message).toMatch(/não conseguiu ler algum arquivo/);
    await expect(z.test(path.join(dir, "b.7z"), null)).resolves.toBeUndefined();
  });

  it("parseArchiveWarnings: caminho a partir da entrada, sem repetir, outros erros com o texto do 7-Zip", () => {
    const out = [
      "/tmp/s/painel/a : errno=2 : No such file or directory",
      "/tmp/s/painel/a : errno=2 : No such file or directory",
      "/outro/lugar/b : errno=5 : Input/output error",
      "linha qualquer",
    ].join("\n");
    expect(parseArchiveWarnings(out, ["/tmp/s/painel"])).toEqual(["painel/a (não encontrado)", "b (Input/output error)"]);
  });

  it("muitos arquivos com aviso: o motivo mostra cinco e conta o resto", async () => {
    const z = new SevenZip({ bin: fakeBin });
    const lines = Array.from({ length: 7 }, (_, i) => `${dir}/f${i} : errno=2 : No such file or directory`).join("\\n");
    await writeFile(fakeBin, FAKE.replace('if (mode === "warnbare") return process.exit(1);', `if (mode === "warnbare") { process.stdout.write("${lines}\\n"); return process.exit(1); }`));
    process.env.FAKE_MODE = "warnbare";
    const err = await z.create(path.join(dir, "b.7z"), [dir], {}).catch((e: unknown) => e);
    expect((err as ArchiveError).message).toMatch(/7 arquivo\(s\): .*f4 \(não encontrado\) e mais 2\./);
  });

  it("disponível só quando o programa existe", async () => {
    expect(await new SevenZip({ bin: fakeBin }).available()).toBe(true);
    expect(await new SevenZip({ bin: path.join(dir, "nao-existe") }).available()).toBe(false);
    const err = await new SevenZip({ bin: path.join(dir, "nao-existe") }).create(path.join(dir, "a.7z"), [dir], {}).catch((e: unknown) => e);
    expect((err as ArchiveError).code).toBe("missing");
  });
});

const REAL = process.env.PAAS_TEST_7Z;
describe.skipIf(!REAL)("SevenZip (7zz de verdade, PAAS_TEST_7Z)", () => {
  it("cria cifrado com nomes cifrados, testa e extrai", async () => {
    const z = new SevenZip({ bin: REAL! });
    const src = path.join(dir, "src");
    await mkdir(path.join(src, "bancos"), { recursive: true });
    await writeFile(path.join(src, "bancos", "app.sql"), "create table x(id int);\n");
    const archive = path.join(dir, "real.7z");
    await z.create(archive, [path.join(src, "bancos")], { password: "frase-secreta-longa" });
    await z.test(archive, "frase-secreta-longa");
    expect(((await z.test(archive, "errada-errada").catch((e: unknown) => e)) as ArchiveError).code).toBe("wrong_password");
    expect(((await z.test(archive, null).catch((e: unknown) => e)) as ArchiveError).code).toBe("wrong_password");
    const out = path.join(dir, "out");
    await z.extract(archive, out, "frase-secreta-longa");
    expect(await readFile(path.join(out, "bancos", "app.sql"), "utf8")).toContain("create table");
  });

  it("entrada que sumiu e arquivo sem permissão: o 7-Zip sai com código 1 e o backup é recusado", async () => {
    const z = new SevenZip({ bin: REAL! });
    const src = path.join(dir, "painel");
    await mkdir(path.join(src, "sub"), { recursive: true });
    await writeFile(path.join(src, "users.json"), "{}");
    await writeFile(path.join(src, "sub", "trancado.key"), "x");
    await chmod(path.join(src, "sub", "trancado.key"), 0o000);
    try {
      const err = await z.create(path.join(dir, "p.7z"), [src, path.join(dir, "sumiu.json")], {}).catch((e: unknown) => e);
      expect((err as ArchiveError).code).toBe("incomplete");
      expect((err as ArchiveError).message).toContain("sumiu.json (não encontrado)");
      expect((err as ArchiveError).message).toContain("painel/sub/trancado.key (sem permissão de leitura)");
    } finally {
      await chmod(path.join(src, "sub", "trancado.key"), 0o600);
    }
  });
});
