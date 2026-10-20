import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/react";
import { beforeEach } from "vitest";
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
