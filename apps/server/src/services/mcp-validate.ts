/**
 * mcp-validate.ts — validação dos argumentos de uma ferramenta MCP contra o JSON Schema que ela publica.
 *
 * Só o subconjunto que as ferramentas usam (tipo, enum, tamanhos, intervalo, padrão, itens, campos
 * obrigatórios e `additionalProperties: false`). Existe para a ferramenta recusar argumento fora do
 * formato ANTES de chamar qualquer coisa; as rotas por trás ainda validam de novo com o schema delas.
 * Devolve o texto do primeiro problema (sem eco do valor recebido) ou null.
 */
export interface McpSchema {
  type?: string | string[];
  enum?: readonly unknown[];
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  items?: McpSchema;
  maxItems?: number;
  required?: readonly string[];
  properties?: Record<string, McpSchema>;
  additionalProperties?: boolean;
  description?: string;
  default?: unknown;
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function typeMatches(want: string, got: string): boolean {
  return want === got || (want === "number" && got === "integer");
}

export function validateMcpArgs(schema: McpSchema, value: unknown, at = "argumentos"): string | null {
  if (schema.type !== undefined) {
    const wanted = Array.isArray(schema.type) ? schema.type : [schema.type];
    const got = typeOf(value);
    if (!wanted.some((w) => typeMatches(w, got))) return `${at}: tipo inválido (esperado ${wanted.join(" ou ")})`;
  }
  if (schema.enum && !schema.enum.includes(value)) return `${at}: valor fora da lista permitida`;
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) return `${at}: curto demais`;
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${at}: longo demais`;
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) return `${at}: formato inválido`;
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) return `${at}: menor que o mínimo`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${at}: maior que o máximo`;
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${at}: itens demais`;
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        const problem = validateMcpArgs(schema.items, value[i], `${at}[${i}]`);
        if (problem) return problem;
      }
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (record[key] === undefined) return `${at}: falta o campo "${key}"`;
    }
    for (const [key, item] of Object.entries(record)) {
      const sub = schema.properties?.[key];
      if (!sub) {
        if (schema.additionalProperties === false) return `${at}: campo desconhecido "${key.slice(0, 40)}"`;
        continue;
      }
      const problem = validateMcpArgs(sub, item, `${at}.${key}`);
      if (problem) return problem;
    }
  }
  return null;
}
