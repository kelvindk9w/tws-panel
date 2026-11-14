/**
 * Reinstalação com o setup já concluído: o instalador (setup_concluido) e o show-token.sh detectam isso e não
 * mostram o quadro do SETUP TOKEN nem a URL com ?token=. Execução real das funções/scripts com um `docker` falso
 * na frente do PATH. O token usado aqui é só um texto de teste, e nenhum teste imprime o valor.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeDirSync } from "./helpers/tmp.js";

const raiz = path.resolve(__dirname, "../../..");
const sh = readFileSync(path.join(raiz, "scripts/install.sh"), "utf8");
const pegar = (nome: string) => sh.match(new RegExp(`^${nome}\\(\\) \\{[\\s\\S]*?^\\}`, "m"))?.[0] ?? "";
const TOKEN_DE_TESTE = "tokenfalsodeteste0123456789abcdef";

const pastas: string[] = [];
afterEach(() => {
  for (const p of pastas.splice(0)) removeDirSync(p);
});

/** `docker` falso: `exec` sai com FAKE_EXEC_RC; `run` imprime o arquivo FAKE_STATE (se houver) como se fosse o volume. */
function dockerFalso() {
  const dir = mkdtempSync(path.join(tmpdir(), "setup-concluido-"));
  pastas.push(dir);
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, "docker"),
    `#!/bin/bash
case "$1" in
  exec) echo x >> "$FAKE_LOG"; exit "\${FAKE_EXEC_RC:-1}" ;;
  run) case "$*" in *setup-state.json*) [ -n "$FAKE_STATE" ] && cat "$FAKE_STATE" ;; *setup-token*) printf '%s' "${TOKEN_DE_TESTE}" ;; esac; exit 0 ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  return { dir, bin, log: path.join(dir, "log") };
}

function setupConcluido(rc: string) {
  const d = dockerFalso();
  writeFileSync(d.log, "");
  const r = spawnSync("bash", ["-c", `${pegar("setup_concluido")}\nsetup_concluido && echo CONCLUIDO || echo NAO`], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${d.bin}:${process.env.PATH ?? ""}`, FAKE_EXEC_RC: rc, FAKE_LOG: d.log, PAAS_SETUP_CHECK_INTERVAL: "0" },
  });
  return { saida: r.stdout.trim(), tentativas: readFileSync(d.log, "utf8").split("\n").filter(Boolean).length, r };
}

describe("install.sh: setup_concluido", () => {
  it("código 10 (completed=true): concluído, sem repetir a consulta", () => {
    const x = setupConcluido("10");
    expect(x.saida).toBe("CONCLUIDO");
    expect(x.tentativas).toBe(1);
  });

  it("código 11 (não concluído ou arquivo ausente): não concluído, sem repetir", () => {
    const x = setupConcluido("11");
    expect(x.saida).toBe("NAO");
    expect(x.tentativas).toBe(1);
  });

  it("não deu para saber (container subindo, node ausente): tenta de novo e, sem resposta, mantém o token", () => {
    for (const rc of ["1", "125", "126", "127"]) {
      const x = setupConcluido(rc);
      expect(x.saida).toBe("NAO");
      expect(x.tentativas).toBe(5);
    }
  });

  it("o script que roda no container devolve 10/11 de verdade (completed true, false, ausente, ilegível)", () => {
    const corpo = pegar("setup_concluido").match(/node -e '([\s\S]*?)'\s*>\/dev\/null/)?.[1] ?? "";
    expect(corpo).toContain("setup-state.json");
    const dir = mkdtempSync(path.join(tmpdir(), "setup-concluido-"));
    pastas.push(dir);
    const rodar = (conteudo: string | null) => {
      const arq = path.join(dir, "estado.json");
      if (conteudo !== null) writeFileSync(arq, conteudo);
      const js = corpo.replace("/data/setup-state.json", conteudo === null ? path.join(dir, "nao-existe.json") : arq);
      return spawnSync("node", ["-e", js], { encoding: "utf8" }).status;
    };
    expect(rodar('{"currentStep":3,"completed":true}')).toBe(10);
    expect(rodar('{"currentStep":1,"completed":false}')).toBe(11);
    expect(rodar(null)).toBe(11);
    expect(rodar("{quebrado")).toBe(1);
  });

  it("o resumo usa a consulta: com setup concluído esconde ?token= e o quadro, e diz que o painel já está configurado", () => {
    expect(sh).toMatch(/if setup_concluido; then\n  SETUP_DONE=1\n  TOKEN_QS=""/);
    expect(sh).not.toMatch(/\/\?token=\$SETUP_TOKEN/);
    expect(sh).toContain("Painel já configurado: entre com sua conta");
    expect(sh).toMatch(/if \[ "\$SETUP_DONE" = "1" \]; then[\s\S]*?Painel já configurado[\s\S]*?else\ncat <<EOF\n\$\{YELLOW\}\$\{BOLD\}┌[\s\S]*?SETUP TOKEN/);
  });

  it("TOKEN_QS é definido antes do primeiro texto que o usa (com set -u, usar antes derruba o instalador no resumo)", () => {
    const def = sh.indexOf('TOKEN_QS="?token=$SETUP_TOKEN"');
    expect(def).toBeGreaterThan(0);
    const usos = [...sh.matchAll(/\$TOKEN_QS|\$\{TOKEN_QS/g)].map((m) => m.index ?? -1);
    expect(usos.length).toBeGreaterThanOrEqual(3);
    for (const i of usos) expect(i).toBeGreaterThan(def);
  });
});

describe("show-token.sh com setup concluído", () => {
  const rodar = (estado: string | null) => {
    const d = dockerFalso();
    let state = "";
    if (estado !== null) {
      state = path.join(d.dir, "setup-state.json");
      writeFileSync(state, estado);
    }
    return spawnSync("bash", [path.join(raiz, "scripts/show-token.sh")], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${d.bin}:${process.env.PATH ?? ""}`, FAKE_STATE: state, PAAS_PUBLIC_IP: "192.0.2.1" },
    });
  };

  it("diz que o setup já foi concluído e não há token válido, sem imprimir token nem URL com ?token=", () => {
    const r = rodar('{\n  "currentStep": 3,\n  "completed": true\n}');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("setup já foi concluído");
    expect(r.stdout).toContain("não há token válido");
    expect(r.stdout + r.stderr).not.toContain(TOKEN_DE_TESTE);
    expect(r.stdout).not.toContain("?token=");
  });

  it("setup não concluído: segue o fluxo antigo e mostra o quadro (verificado sem imprimir o valor)", () => {
    const r = rodar('{"currentStep":1,"completed":false}');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("SETUP TOKEN");
    expect(r.stdout.includes(TOKEN_DE_TESTE)).toBe(true);
  });

  it("sem arquivo de estado: comportamento antigo", () => {
    const r = rodar(null);
    expect(r.stdout).toContain("SETUP TOKEN");
  });
});
