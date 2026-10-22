# Relatório: retorno ao parar/iniciar/remover projeto

## O que acontecia antes
- Parar/Iniciar: o clique chamava POST /api/projects/:id/stop|start (síncrono, até 120 s, o servidor só responde após o docker stop) e depois atualizava a página. O botão não mudava (sem spinner nem "Parando…"), não havia mensagem de sucesso, e o único sinal era o selo de status mudar sozinho. Só havia aviso em caso de erro.
- Remover: depois de confirmar, a tela simplesmente ia para a lista, sem dizer que removeu.
- Não existe "Reiniciar" do projeto na tela nem botões de ação na lista do Dashboard.
- Parar não toca no Caddy: o domínio passa a mostrar a página "Site temporariamente indisponível" (503). Nada é apagado. Remover não exige parar antes.

## O que mudou (comportamento)
- Componente reutilizável `apps/web/src/components/ActionNotice.tsx` (sucesso/atenção/erro, região role=status, erro role=alert, sem sumir sozinho).
- `ProjectDetailPage.tsx`: spinner + rótulo de andamento, botões travados, clique duplo ignorado, confirmação pelo estado real (GET do projeto, até ~30 s), sucesso só se o estado bate, aviso "não confirmei" com "Verificar de novo", erro com "Tentar de novo", resposta tardia descartada ao trocar de projeto, foco devolvido ao botão seguinte.
- Zona de perigo explica que não precisa parar antes; o texto do estado "parado" explica o que ocorre com o site.
- `DashboardPage.tsx`: aviso "Projeto removido" após a remoção.
- Servidor inalterado (a API já permite confirmar o estado).

## Testes
`apps/web/tests/project-lifecycle-feedback.test.tsx` (pt-BR e en).
