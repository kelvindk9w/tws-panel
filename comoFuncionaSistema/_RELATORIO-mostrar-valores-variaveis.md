# Relatório — "Mostrar valores" como padrão de todas as variáveis

Pedido do dono: depois de "Mostrar valores", variável nova ou pesquisa voltava a ocultar as linhas.

## Comportamento
- O botão global define o PADRÃO de todas as linhas: existentes, recém-criadas, importadas de .env e as que voltam ao mudar ou limpar a pesquisa. Mudar a pesquisa nunca altera o estado de ninguém.
- O olho individual sobrepõe só a própria linha. Clicar no botão global descarta todos os olhos e aplica o novo estado a todas, inclusive às que a pesquisa esconde.
- Linhas "sob demanda" (senha da caixa): ao mostrar, o painel pede todas as ainda não carregadas, também as fora do filtro. O pedido só sai sob clique (global ou olho); o valor fica em memória, então ocultar e mostrar de novo não repete.
- Regra de ouro: nunca revelar depois de a pessoa mandar ocultar. Cada clique do botão global sobe uma época e cada olho tem a sua última vontade; a resposta tardia do servidor vai só para a memória (cache) e só aparece se o estado ainda for "mostrar". Clicar de novo no olho enquanto carrega cancela. Pedidos repetidos do mesmo nome reaproveitam a busca em andamento (mostrar, ocultar, mostrar rápido faz uma chamada só).
- Falha ao revelar: uma mensagem por variável, dizendo qual ficou oculta; some quando uma nova tentativa dá certo. As demais linhas continuam. Spinner no olho da linha do e-mail e no botão global enquanto carrega; o botão pode ser clicado a qualquer momento.
- O botão global muda o rótulo (Mostrar/Ocultar valores) e não usa aria-pressed junto (seria sinal duplicado).
- Estado só em memória (nada em localStorage ou URL); oculto = `type=password`. Ao salvar, os olhos individuais acompanham a variável pelo nome: o que foi ocultado não reaparece; o padrão global permanece.
- Dica da pesquisa (pt-BR e en) conta como o topo, linhas do e-mail incluídas ("1 de 4"), e diz que "Mostrar valores", "Apagar todas" e "Salvar variáveis" valem para todas.

## Custo e segurança
Não existe rota em lote; são uma chamada por senha (poucas: as das caixas), feitas em paralelo, cada uma com Auditoria e dentro do limite de 30 por minuto por projeto. Nunca há busca automática.

## Arquivos
- apps/web/src/components/ProjectEnvCard.tsx
- apps/web/src/locales/{pt-BR,en}/env.ts
- apps/web/tests/env-show-values.test.tsx (novo); apps/web/tests/project-env-search.test.tsx (ajustado)
- comoFuncionaSistema/projetos/conceito-pagina-do-projeto.json
