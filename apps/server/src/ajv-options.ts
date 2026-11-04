/**
 * Opções do Ajv usadas na validação de schema das rotas.
 *
 * Os defaults do Fastify são permissivos por conveniência e inadequados para
 * validação de segurança:
 *  - `coerceTypes: true` converteria o número 123 em "123" num campo string,
 *    aceitando um corpo que o schema deveria recusar;
 *  - `removeAdditional: true` apagaria em silêncio propriedades desconhecidas
 *    em vez de recusar a requisição, escondendo cliente malformado ou tentativa
 *    de definir campo interno.
 * Ambos são desligados: o schema recusa, não conserta.
 */
export const AJV_OPTIONS = {
  customOptions: {
    coerceTypes: false,
    removeAdditional: false,
    useDefaults: true,
    allErrors: false,
  },
} as const;
