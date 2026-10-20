---
title: "Traduzir a interface"
---

A interface do painel existe em inglês e em português do Brasil (`pt-BR`, o idioma de origem). Adicionar outro idioma
exige **só arquivos novos**: nenhum componente muda.

> [!NOTE]
> Isto vale para a interface web (`apps/web`). As mensagens que o próprio servidor devolve (erros da API, entradas de
> auditoria, checagens de saúde) ainda são escritas em português e aparecem como chegam; estão listadas para uma fase
> seguinte. A documentação mora em `site/` e tem pastas de idioma próprias.

## Como funciona

- Os textos ficam em `apps/web/src/locales/<idioma>/<área>.ts`, um objeto plano por área (`common`, `projects`, `mail`, `backups`...).
- Um texto é lido pela chave `área.chave`, por exemplo `t("projects.list.empty")`.
- `{nome}` insere um valor. Plurais usam os sufixos `_one` / `_other` (e `_zero`, `_few`, `_many` quando o idioma pede) e o valor `count`.
- Etiquetas como `<b>...</b>` marcam negrito, código e links em alguns textos longos. Mantenha as mesmas etiquetas e as mesmas `{variáveis}` do texto de origem.
- Chave ausente em um idioma cai para o `pt-BR`. Se faltar lá também, nada aparece (texto vazio) e o console do navegador avisa em desenvolvimento. O teste de paridade e o typecheck impedem que os dicionários do repositório cheguem a esse ponto.
- Valores inseridos com `{nome}` são sempre texto puro, mesmo dentro de `<b>...</b>`: nunca viram marcação.
- O idioma é escolhido na primeira visita pelo navegador (`pt*` vira `pt-BR`, qualquer outro vira inglês) e depois pelo seletor de idioma no menu do usuário, na tela de login e em Configurações → Aparência. A escolha fica guardada no navegador (`localStorage`, chave `paas.locale`).
- Datas, horas, números e ordenação seguem o idioma pelo `Intl`. O fuso horário configurado nunca muda por causa do idioma.

## Adicionar um idioma (por exemplo, espanhol)

1. Copie a pasta `apps/web/src/locales/en/` para `apps/web/src/locales/es/` (o nome da pasta é o código do idioma).
2. Traduza os valores de todos os arquivos. Não renomeie chaves. Mantenha `{variáveis}` e etiquetas como estão. Siga o `apps/web/src/locales/GLOSSARY.md` para que o mesmo conceito tenha sempre a mesma palavra.
3. Em `common.ts`, ajuste `"language.name"` para o idioma escrito nele mesmo (por exemplo `"Español"`): é o que o seletor mostra.
4. Rode as verificações em `apps/web`:

   ```bash
   pnpm test -- tests/i18n-parity.test.ts   # mesmas chaves, variáveis e etiquetas do pt-BR
   pnpm test:coverage                       # suíte inteira
   pnpm typecheck && pnpm build
   ```

5. Abra o painel, escolha o idioma no seletor e percorra as páginas principais. Nenhuma chave crua como `projects.list.empty` deve aparecer.
6. Abra um pull request. Veja o [CONTRIBUTING.md](https://github.com/kelvindk9w/tws-panel/blob/main/CONTRIBUTING.md).

O idioma novo é reconhecido sozinho: o seletor, a detecção do navegador (`es-MX` vira `es`) e o fallback leem as pastas de `locales/`.

## Mudar ou acrescentar um texto

Edite os arquivos `pt-BR` e `en` juntos. Um teste falha se uma chave existir só em um deles, se as variáveis forem diferentes ou se um componente voltar a trazer texto fixo em português em vez de uma chave.
