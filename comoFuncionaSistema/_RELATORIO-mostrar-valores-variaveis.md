# Relatório — "Mostrar valores" como padrão de todas as variáveis

Pedido do dono: depois de "Mostrar valores", variável nova ou pesquisa voltava a ocultar as linhas.

## Comportamento
- O botão global define o PADRÃO de todas as linhas: existentes, recém-criadas, importadas de .env e as que voltam ao mudar ou limpar a pesquisa. Mudar a pesquisa nunca altera o estado de ninguém.
- O olho individual sobrepõe só a própria linha. Clicar no botão global descarta todos os olhos e aplica o novo estado a todas, inclusive às que a pesquisa esconde.
- Linhas "sob demanda" (senha da caixa): ao mostrar, o painel pede todas as ainda não carregadas, também as fora do filtro. O pedido só sai sob clique (global ou olho); o valor fica em memória, então ocultar e mostrar de novo não repete.
- Falha ao revelar: uma mensagem, só aquela linha fica oculta, as demais continuam. O botão mostra um spinner durante a busca e permite ocultar a qualquer momento.
- Botão global com `aria-pressed` e rótulo conforme o estado real; os olhos individuais já refletiam o estado.
- Estado só em memória (nada em localStorage ou URL); oculto = `type=password`. Após "Salvar variáveis" os olhos individuais são descartados e o padrão global permanece.
- Dica da pesquisa reescrita (pt-BR e en): "Mostrar valores", "Apagar todas" e "Salvar variáveis" valem para todas.

## Custo e segurança
Não existe rota em lote; são uma chamada por senha (poucas: as das caixas), feitas em paralelo, cada uma com Auditoria e dentro do limite de 30 por minuto por projeto. Nunca há busca automática.

## Arquivos
- apps/web/src/components/ProjectEnvCard.tsx
- apps/web/src/locales/{pt-BR,en}/env.ts
- apps/web/tests/env-show-values.test.tsx (novo); apps/web/tests/project-env-search.test.tsx (ajustado)
- comoFuncionaSistema/projetos/conceito-pagina-do-projeto.json
