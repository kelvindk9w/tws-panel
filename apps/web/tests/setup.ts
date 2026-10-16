import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/react";

// Com a suíte inteira e a cobertura rodando juntas, uma tela que carrega
// vários cartões pode passar de 1 s para aparecer; o padrão do findBy/waitFor
// (1 s) reprovava testes certos de forma intermitente.
configure({ asyncUtilTimeout: 5000 });
