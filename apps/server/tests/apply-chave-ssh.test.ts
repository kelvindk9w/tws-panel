/**
 * apply-chave-ssh.test.ts — instalar chave SSH pela fase 01 do hardening (POST /api/security/apply com
 * sshPublicKey) é o mesmo poder de "adicionar chave" em Acesso à VPS: nunca por token de API e sempre
 * com senha. (Regressão da revisão: antes qualquer token admin ou sessão instalava chave sem reautenticar.)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PASSWORD, startRealPanel, type RealPanel } from "./helpers/real-panel.js";

let panel: RealPanel;
beforeAll(async () => {
  panel = await startRealPanel();
}, 120_000);
afterAll(async () => panel.close());

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIC9JAFDTUqwvSdNKOQH1xA7JKESeoFlhyGblHHhgofBT atacante";

describe("POST /api/security/apply com chave SSH", () => {
  it("token de API (mesmo admin, painel inteiro) é recusado", async () => {
    const tok = (await panel.createToken({ name: "adm", reach: "panel" })).token;
    const res = await panel.app.inject({
      method: "POST",
      url: "/api/security/apply",
      headers: { authorization: `Bearer ${tok}` },
      payload: { phase: "01", dryRun: false, sshUser: "admin", sshPublicKey: KEY, currentPassword: PASSWORD },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("token_forbidden");
  });

  it("sessão humana sem senha, ou com senha errada, é recusada e nada é instalado", async () => {
    const semSenha = await panel.app.inject({
      method: "POST",
      url: "/api/security/apply",
      headers: { cookie: panel.cookie },
      payload: { phase: "01", dryRun: false, sshUser: "admin", sshPublicKey: KEY },
    });
    expect(semSenha.statusCode).toBe(401);
    expect(semSenha.json().error).toBe("invalid_current_password");
    const errada = await panel.app.inject({
      method: "POST",
      url: "/api/security/apply",
      headers: { cookie: panel.cookie },
      payload: { phase: "01", dryRun: false, sshUser: "admin", sshPublicKey: KEY, currentPassword: "errada" },
    });
    expect(errada.statusCode).toBe(401);
  });
});
