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

## Correções da revisão (veredito: reprovado, 7 achados)

| # | Achado | Correção (comportamento) | Teste |
|---|---|---|---|
| 1 | Crítico: `guardrailOverride` por token limitado dava root na VPS | Nenhum token, de nenhum escopo ou alcance, pode pedir o override: 403 `token_forbidden`; só a sessão humana | `token-revisao-0b` (1), `token-policy-rotas` |
| 2 | Alto: repositório privado alheio clonado com a conta GitHub conectada | Projeto criado por token limitado leva a marca `noAccountCredential`; `credentialFor` só usa a credencial própria; a pessoa libera com `PUT /api/projects/:id/account-credential` (senha, +2FA), negada a token; botão na aba Git | `token-revisao-0b` (2), `project-config-card` |
| 3 | Médio: sequestro por apelido se `forgetProject` falha | O plugin exige projeto com o id EXATO antes de qualquer rota de projeto/alvo de um token limitado; DELETE que não limpa as listas responde 500 `token_lists_not_updated` e audita | `token-revisao-0b` (3) |
| 4 | Baixo: `reach:"panel"` com lista/`canCreate` virava painel inteiro | Combinação inconsistente = sem alcance (falha fechada); vazios como o painel grava seguem painel | `api-token-store-alcance` |
| 5 | Baixo: oráculo de nome por sufixo | Apelido de projeto de token limitado SEMPRE com sufixo aleatório de 4 hexa | `token-revisao-0b` (5) |
| 6 | Baixo: corrida no PATCH do alcance | Compare-and-set dentro da fila de gravação (`updateReach` com `expected`); 409 `token_reach_changed`; a tela envia `basedOn` e marca o projeto novo ao recarregar | `token-revisao-0b` (6), `api-token-store-alcance`, `api-access-settings` |
| 7 | Obs.: token limitado apagava projeto; "pode criar" sem administração | DELETE por token limitado = 403 até a confirmação humana (fase 3); "pode criar" só com escopo admin (400 no servidor, tela não oferece) | `token-revisao-0b` (7), `token-alcance-matriz` |

Escopo de criação de projeto: `POST /api/projects` já exige administração (`ADMIN_ROUTES`), por isso "pode criar" exige administração.

Discordância registrada: nenhuma. Observação: a credencial PRÓPRIA do projeto continua valendo com a marca (é a pessoa quem a põe).
Não verificado: igual à fase (sem Docker real, sem VPS, interface não vista em navegador).
