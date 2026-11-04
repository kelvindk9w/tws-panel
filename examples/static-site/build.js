/**
 * Build mínimo: copia src/ → dist/ (simula `next build` com output: "export",
 * que gera out/, ou `vite build`, que gera dist/).
 */
import { cpSync, writeFileSync } from "node:fs";

cpSync("src", "dist", { recursive: true });
writeFileSync("dist/BUILD.txt", `buildado em ${new Date().toISOString()}\n`);
console.log("build ok → dist/");
