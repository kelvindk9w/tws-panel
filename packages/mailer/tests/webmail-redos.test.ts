import { describe, expect, it } from "vitest";
import { parseFailedLogins } from "../src/webmail.js";

const line = (user: string, from: string) =>
  `[03-Oct-2026 23:10:00 +0000]: <abcd1234> Failed login for ${user} from ${from} in session abcd1234abcd1234 (error: 0)`;

describe("parseFailedLogins — entrada hostil", () => {
  it("o X-Forwarded-For é o último IP da lista", () => {
    const out = parseFailedLogins(line("a@b.com", "172.18.0.5 (X-Forwarded-For: 203.0.113.1, 203.0.113.9)"));
    expect(out).toEqual([{ ip: "203.0.113.9", user: "a@b.com" }]);
  });

  it("sem X-Forwarded-For usa o IP de origem", () => {
    expect(parseFailedLogins(line("a@b.com", "203.0.113.5 (X-Real-IP: 198.51.100.4)"))).toEqual([{ ip: "203.0.113.5", user: "a@b.com" }]);
    expect(parseFailedLogins(line("a@b.com", "203.0.113.5"))).toEqual([{ ip: "203.0.113.5", user: "a@b.com" }]);
  });

  it("X-Forwarded-For longo (centenas de IPs) continua contando a tentativa", () => {
    const lista = Array.from({ length: 300 }, (_, i) => `198.51.100.${i % 250}`).join(", ") + ", 203.0.113.77";
    expect(parseFailedLogins(line("a@b.com", `172.18.0.5 (X-Forwarded-For: ${lista})`))).toEqual([{ ip: "203.0.113.77", user: "a@b.com" }]);
  });

  it("usuário de 100 KB ainda conta a tentativa e extrai o IP", () => {
    const user = "u".repeat(100_000) + "@b.com";
    const t0 = Date.now();
    const out = parseFailedLogins(line(user, "172.18.0.5 (X-Forwarded-For: 203.0.113.9)"));
    expect(out).toEqual([{ ip: "203.0.113.9", user }]);
    expect(Date.now() - t0).toBeLessThan(100);
  });

  it("linha de 200 KB sem ')' roda em tempo linear", () => {
    const t0 = Date.now();
    expect(parseFailedLogins("Failed login for u from ! (".repeat(8_000))).toEqual([]);
    expect(parseFailedLogins("x " + "(X-Forwarded-For: ".repeat(11_000))).toEqual([]);
    expect(parseFailedLogins(line("a@b.com", "x " + "(X-Forwarded-For: ".repeat(11_000)))).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(100);
  });

  it("marcador repetido: acha a linha válida que vem depois de tentativas quebradas", () => {
    const ok = line("a@b.com", "203.0.113.5");
    // o usuário é tudo entre "Failed login for " e o ÚLTIMO " from " antes do fim
    expect(parseFailedLogins(`Failed login for x from ${ok.slice(ok.indexOf("Failed"))}`)).toEqual([
      { ip: "203.0.113.5", user: "x from Failed login for a@b.com" },
    ]);
  });

  it("usuário que imita o formato não faz culpar outro IP: vale o IP do fim da linha", () => {
    const evil = "x from 198.51.100.77 in session a (error: 0) y";
    expect(parseFailedLogins(line(evil, "172.18.0.5 (X-Forwarded-For: 203.0.113.9)"))).toEqual([{ ip: "203.0.113.9", user: evil }]);
    expect(parseFailedLogins(line(evil, "203.0.113.5"))).toEqual([{ ip: "203.0.113.5", user: evil }]);
    const parens = "x (X-Forwarded-For: 198.51.100.77) y";
    expect(parseFailedLogins(line(parens, "203.0.113.5"))).toEqual([{ ip: "203.0.113.5", user: parens }]);
    // espaço/retorno de carro no fim da linha (CRLF) não muda nada
    expect(parseFailedLogins(line("a@b.com", "203.0.113.5") + "\r")).toEqual([{ ip: "203.0.113.5", user: "a@b.com" }]);
  });

  it("linhas de 1 MB (usuário gigante, marcadores repetidos) rodam em tempo linear", () => {
    const t0 = Date.now();
    const grande = "x from 198.51.100.77 in session a (error: 0) ".repeat(25_000);
    expect(parseFailedLogins(line(grande, "203.0.113.5"))).toEqual([{ ip: "203.0.113.5", user: grande }]);
    expect(parseFailedLogins("Failed login for u from ! (".repeat(40_000))).toEqual([]);
    expect(parseFailedLogins(" in session ".repeat(80_000) + " (error: 1)")).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it("formas inválidas são ignoradas", () => {
    const bad = [
      "Failed login for  from 1.2.3.4 in session s (error: 0)",
      "Failed login for u from  in session s (error: 0)",
      "Failed login for u from 203.0.113.5 in session  (error: 0)",
      "Failed login for u from 203.0.113.5 in session s (error: )",
      "Failed login for u from 203.0.113.5 in session s (error: x)",
      "Failed login for u from 203.0.113.5 in session s (error: 12",
      "Failed login for u from 203.0.113.5 in session s",
      "Failed login for u from 203.0.113.5 (sem fecha in session s (error: 0)",
      "Failed login for u 203.0.113.5 in session s (error: 0)",
      "Failed login for u from 203.0.113.5 (x)in session s (error: 0)",
      "Failed login for u from 203.0.113.5 (a)b) in session s (error: 0)",
      "Failed login for u from 203.0.113.5 x in session s (error: 0)",
      "Failed login for u from 203.0.113.5 in session s t (error: 0)",
      " from 203.0.113.5 in session s (error: 0)",
      "u from 203.0.113.5 in session s (error: 0)",
    ];
    expect(parseFailedLogins(bad.join("\n"))).toEqual([]);
    expect(parseFailedLogins("Failed login for u from 203.0.113.5 in session s (error: -3)")).toEqual([{ ip: "203.0.113.5", user: "u" }]);
  });
});
