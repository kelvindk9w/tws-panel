import { describe, expect, it } from "vitest";
import { renderConfigToml, stalwartConfigFingerprint } from "../src/server.js";

const secret = "ab".repeat(32);
const hook = { url: "http://tws-panel:9100/mail-hook/send", secret };

describe("renderConfigToml — aviso de envio (MTA hook)", () => {
  it("sem aviso configurado, não há seção de hook", () => {
    expect(renderConfigToml("mail.exemplo.com", "s")).not.toContain("session.hook");
  });

  it("com aviso: só envio autenticado, sem derrubar o envio se o painel falhar", () => {
    const toml = renderConfigToml("mail.exemplo.com", "s", [], { sendHook: hook });
    expect(toml).toContain('[session.hook."paas-send-log"]');
    expect(toml).toContain('enable = [{if = "!is_empty(authenticated_as)", then = true}, {else = false}]');
    expect(toml).toContain('url = "http://tws-panel:9100/mail-hook/send"');
    expect(toml).toContain('timeout = "2s"');
    expect(toml).toContain('stages = ["data"]');
    expect(toml).toContain(`Authorization: Bearer ${secret}`);
    expect(toml).toContain("tempfail-on-error = false");
  });

  it("recusa endereço ou segredo fora do formato (nada de texto livre na configuração)", () => {
    expect(() => renderConfigToml("m.x.com", "s", [], { sendHook: { ...hook, url: 'http://a:9100/x"\nfoo' } })).toThrow(/endereço/);
    expect(() => renderConfigToml("m.x.com", "s", [], { sendHook: { ...hook, secret: 'x"\nfoo' } })).toThrow(/segredo/);
  });

  it("a impressão digital muda com o aviso e com o segredo", () => {
    const base = { hostname: "mail.exemplo.com", certificateHosts: [] };
    const a = stalwartConfigFingerprint(base);
    const b = stalwartConfigFingerprint({ ...base, sendHook: hook });
    const c = stalwartConfigFingerprint({ ...base, sendHook: { ...hook, secret: "cd".repeat(32) } });
    expect(new Set([a, b, c]).size).toBe(3);
  });
});
