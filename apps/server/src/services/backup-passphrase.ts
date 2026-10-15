/**
 * backup-passphrase.ts — "Sugerir uma frase forte" para a senha dos backups.
 *
 * Seis palavras comuns em português (sem acento, para digitar em qualquer
 * teclado) sorteadas com crypto.randomInt, mais um número de 3 dígitos:
 * 6 × log2(256) + log2(900) ≈ 57 bits. Contra o 7z (AES-256 com a chave
 * derivada por 2^19 rodadas de SHA-256) isso já é muito caro de adivinhar,
 * e é fácil de anotar no papel.
 */
import { randomInt } from "node:crypto";

export const PASSPHRASE_WORDS: readonly string[] = [
  "abelha", "abacate", "agulha", "alface", "alegre", "amarelo", "amigo", "ancora", "anel", "anjo",
  "areia", "arroz", "asa", "azul", "bairro", "balde", "banana", "banco", "barco", "batata",
  "beijo", "bicho", "bolo", "bola", "bolsa", "bombom", "bosque", "braco", "brisa", "bule",
  "burro", "cabra", "cadeira", "caderno", "cafe", "caixa", "cajado", "calor", "cama", "camelo",
  "campo", "caneca", "caneta", "canoa", "capa", "carro", "carta", "casa", "castelo", "cavalo",
  "cebola", "cedro", "cego", "cenoura", "cereja", "chave", "chuva", "cidade", "cinema", "cinto",
  "cobra", "coelho", "colher", "copo", "coral", "corda", "coruja", "costa", "couve", "cravo",
  "cristal", "dado", "dedo", "dente", "deserto", "doce", "dragao", "duna", "escada", "escola",
  "espelho", "estrela", "faca", "farol", "fazenda", "feijao", "feira", "ferro", "festa", "figo",
  "fita", "flauta", "flor", "floresta", "fogo", "folha", "fonte", "forno", "foto", "fruta",
  "fumo", "funil", "gaiola", "galho", "galo", "garfo", "gato", "gelo", "girafa", "goiaba",
  "gota", "grama", "grilo", "gruta", "guarda", "harpa", "hino", "horta", "ilha", "janela",
  "jardim", "jarra", "joia", "jogo", "lago", "lagoa", "lama", "lampada", "lanche", "lapis",
  "laranja", "leao", "leite", "lenco", "lenha", "limao", "linha", "livro", "lobo", "lontra",
  "lua", "luva", "maca", "macaco", "madeira", "manga", "mapa", "mar", "martelo", "mel",
  "melancia", "mesa", "milho", "mochila", "moeda", "moinho", "montanha", "morango", "mosca", "mundo",
  "musica", "navio", "neve", "ninho", "noite", "nuvem", "oceano", "ola", "onda", "ouro",
  "ovelha", "ovo", "padaria", "palha", "palmeira", "panela", "pao", "papel", "pato", "pavao",
  "pedra", "peixe", "pena", "pente", "pera", "perfume", "pincel", "pinho", "pipa", "piano",
  "planeta", "pombo", "ponte", "porta", "praia", "prato", "quadro", "queijo", "rabo", "radio",
  "raiz", "rato", "relogio", "remo", "rede", "rio", "roda", "rosa", "roupa", "sabao",
  "sal", "salada", "sapato", "sapo", "selo", "semente", "serra", "sino", "sofa", "sol",
  "sopa", "tapete", "tartaruga", "teatro", "telhado", "tenda", "terra", "tesoura", "tigre", "tijolo",
  "tinta", "toalha", "tomate", "torre", "trem", "trigo", "trovao", "tucano", "uva", "vaca",
  "vaso", "vela", "vento", "verde", "vidro", "vila", "vinho", "violao", "vulcao", "xicara",
  "zebra", "aurora", "bambu", "cacau", "garoa", "orvalho",
];

export function suggestPassphrase(random: (max: number) => number = (max) => randomInt(max)): string {
  const words = Array.from({ length: 6 }, () => PASSPHRASE_WORDS[random(PASSPHRASE_WORDS.length)]!);
  return `${words.join("-")}-${100 + random(900)}`;
}
