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
import { ArchiveError, SevenZip } from "../src/services/backup-archive.js";

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
  await rm(dir, { recursive: true, force: true });
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
    const z = new SevenZip({ bin: fakeBin, timeoutMs: 200 });
    process.env.FAKE_MODE = "crash";
    const err = await z.test(path.join(dir, "x.7z"), null).catch((e: unknown) => e);
    expect((err as ArchiveError).code).toBe("failed");
    expect((err as ArchiveError).message).toMatch(/Data Error/);
    process.env.FAKE_MODE = "slow";
    const slow = await z.test(path.join(dir, "x.7z"), null).catch((e: unknown) => e);
    expect((slow as ArchiveError).code).toBe("timeout");
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
});
