/**
 * A pasta de instalação do painel (a que guarda o .env com os segredos) precisa chegar ao processo do
 * painel mesmo quando o instalador foi usado com outra pasta que não /opt/tws-panel. Verificação de
 * texto sobre o install.sh e o docker-compose.yml (não executa o instalador).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const raiz = path.resolve(__dirname, "../../..");
const ler = (arquivo: string) => readFileSync(path.join(raiz, arquivo), "utf8");

describe("PAAS_HOST_REPO_DIR (pasta de instalação no host)", () => {
  it("o docker-compose.yml repassa a variável ao container, com o padrão antigo", () => {
    expect(ler("docker-compose.yml")).toMatch(/PAAS_HOST_REPO_DIR:\s*\$\{PAAS_HOST_REPO_DIR:-\/opt\/tws-panel\}/);
  });

  it("o install.sh grava o caminho REAL da instalação (APP_DIR) no .env, sobrescrevendo valor antigo", () => {
    const sh = readFileSync(path.join(raiz, "scripts/install.sh"), "utf8");
    expect(sh).toMatch(/env_set PAAS_HOST_REPO_DIR "\$APP_DIR"/);
  });
});
