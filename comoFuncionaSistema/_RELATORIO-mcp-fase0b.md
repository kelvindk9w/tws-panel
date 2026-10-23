# Relatório — MCP, Fase 0b: alcance por projeto nos tokens de API

Base: `plano-mcp.md` (seção 10) e a Fase 0 (`_RELATORIO-mcp-fase0.md`). Escopo: só o alcance do token.
**Não existe `/mcp` nem a Fase 1.**

## O que passou a acontecer

1. **Alcance escolhido na criação.** Além do nível (leitura, escrita, administração), o token tem um
   alcance: o painel inteiro (como na Fase 0), só os projetos escolhidos, ou os escolhidos mais "pode criar
   projetos novos". Os projetos precisam existir; lista vazia sem "pode criar" é recusada. A validação roda
   antes de pedir a senha.
2. **Fora da lista o projeto não existe.** As listagens filtram, e o pedido direto por número de um projeto
   fora do alcance dá o mesmo 404 de um projeto inexistente (mesmo corpo e cabeçalhos), antes de qualquer
   validação de corpo e antes da checagem de nível.
3. **Painel e servidor ficam fora.** Token limitado recebe 403, no mesmo formato da Fase 0, em: domínio do
   painel, e-mail do servidor, backups e restauração do painel, segurança, usuários/2FA/sessões, avisos
   globais, integrações, configurações, containers/portas/certificados/auditoria/alertas globais, terminal
   e outros tokens. Cada uma das 187 rotas tem uma classificação de alcance, conferida por teste contra o
   painel real; rota sem classificação vale "painel" em execução.
4. **Criar projeto.** Com "pode criar", o projeto novo entra na lista do token no mesmo passo. Se o
   registro falhar, o projeto é desfeito e volta erro claro; se nem o desfazer funcionar, o erro diz o nome
   do projeto e que ele está fora do alcance do token. Só vale origem Git, e o token limitado não troca a
   fonte de um projeto.
5. **Conflitos sem pista.** Domínio ou porta usados por algo fora do alcance voltam como "indisponível",
   sem dizer quem usa. Humano e token de painel inteiro continuam vendo a mensagem completa.
6. **Gestão.** Tela com seletor de alcance, linha de alcance por token e "Editar projetos". Editar é só
   por humano; aumentar pede senha (e 2FA), diminuir não. Apagar projeto o tira de todas as listas; ids são
   aleatórios e não se reaproveitam; a busca agora prefere o id exato ao apelido.
7. **Falha fechada.** Arquivo da Fase 0 = painel inteiro. Alcance ilegível ou inválido = token sem alcance.
8. **Auditoria.** Ator `token:<nome>`; criar projeto e mudar alcance são registrados.

## Decisões e por quê

- Conferir o alcance antes do nível: assim nada vaza pela diferença entre 403 e 404.
- Rotas globais negadas em vez de filtradas: filtrar é mais superfície; pode vir na Fase 1 se precisar.
- Teste de restauração de backup é do painel: grava dados de um projeto no banco de outro.
- Aumentar exige senha e diminuir não: tirar acesso é sempre seguro e precisa ser rápido.
- Deploy/escrita equivale a acesso às variáveis DAQUELE projeto (documentado); limitar o alcance é a
  proteção, mas não é uma caixa isolada.

## Não verificado

- Nada foi testado contra Docker real nem VPS: os testes usam o painel real com Docker simulado.
- Interface não foi vista em navegador real; só testes de componente.

## Riscos

- O código publicado roda no servidor sob as regras do deploy; o repositório pode ser qualquer um que a
  conta GitHub conectada consiga ler.
- Rota nova precisa de classificação de alcance; sem ela fica negada a token limitado (seguro, mas pode
  surpreender).
