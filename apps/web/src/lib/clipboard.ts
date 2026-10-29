/**
 * Copia um texto para a área de transferência. `navigator.clipboard` só
 * existe em página segura (https); fora dela, cai no método antigo.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // segue para o método antigo
  }
  let area: HTMLTextAreaElement | null = null;
  try {
    area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    // o texto pode ser segredo: a caixa invisível nunca fica no DOM
    area?.remove();
  }
}

/**
 * Copia um texto que ainda está sendo preparado (ex.: depende de uma busca ao
 * servidor). A escrita começa na hora, com a promessa dentro de um ClipboardItem —
 * assim o Safari mantém o gesto da pessoa. Sem essa API, espera o texto e usa
 * `copyText`. Se a promessa falhar, devolve false (quem chamou já a trata).
 */
export async function copyTextLater(text: Promise<string>): Promise<boolean> {
  try {
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      const blob = text.then((t) => new Blob([t], { type: "text/plain" }));
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
      return true;
    }
  } catch {
    // segue para o texto simples
  }
  try {
    return await copyText(await text);
  } catch {
    return false;
  }
}
