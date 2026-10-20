import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import { setLocale, STORAGE_KEY } from "../src/i18n/core";

// Com a suíte inteira e a cobertura rodando juntas, uma tela que carrega
// vários cartões pode passar de 1 s para aparecer; o padrão do findBy/waitFor
// (1 s) reprovava testes certos de forma intermitente.
configure({ asyncUtilTimeout: 5000 });

// Idioma padrão dos testes: pt-BR (os testes consultam textos em português).
// Os testes de i18n trocam o idioma por conta própria.
beforeEach(() => {
  window.localStorage.removeItem(STORAGE_KEY);
  setLocale("pt-BR", { persist: false });
});

// Chave de tradução ausente em qualquer teste = erro (o i18n avisa com console.warn).
const missingKeys: string[] = [];
const realWarn = console.warn;
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].startsWith("[i18n] chave ausente")) missingKeys.push(args[0]);
  realWarn(...args);
};
afterEach(() => {
  if (missingKeys.length) {
    const found = missingKeys.splice(0).join("\n");
    throw new Error(`Chave(s) de tradução ausente(s):\n${found}`);
  }
});
