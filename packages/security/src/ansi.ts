/**
 * ansi.ts — remove sequências de escape ANSI de saídas capturadas do alvo.
 *
 * Bug real (check docker.sock-mounted): os checks do scanner rodam via PTY
 * (visão dupla — saída ao vivo no terminal web), então comandos como `grep`
 * colorizam a saída (--color=auto ativa com tty) e os códigos de cor
 * (ex.: ESC[01;31m…ESC[mESC[K) vazavam para o campo `detail`, exibido como
 * texto puro nos cards da UI. O strip é feito em UM ponto central (scanner),
 * cobrindo todos os checks — presentes e futuros.
 */

// Sequências cobertas:
//  - CSI: ESC [ params finais (cores, cursor, erase — ex.: ESC[01;31m, ESC[K);
//  - OSC: ESC ] ... BEL ou ST (títulos de janela, hyperlinks);
//  - escapes de 2 chars (Fe): ESC + @-Z\-_.
const ANSI_PATTERN = new RegExp(
  [
    String.raw`[\u001B\u009B]\[[0-?]*[ -/]*[@-~]`,
    String.raw`\u001B\].*?(?:\u0007|\u001B\\)`,
    String.raw`[\u001B\u009B][@-Z\\-_]`,
  ].join("|"),
  "g",
);

/** Remove todas as sequências de escape ANSI de uma string. */
export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}
