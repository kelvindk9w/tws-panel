# Handoff — revisor da fase 0b (MCP: alcance por projeto dos tokens de API)

## 1. Tarefa e brief (resumo)

O brief original **não está mais disponível no meu contexto**: a conversa deste
subagente começa já no meio, com um comando que tentava entrar na cópia de
revisão `rev-mcp0b` e rodar o build do `@paas/core`. Pelo que dá para inferir
do estado do repositório e do nome da cópia:

- Revisar a **fase 0b** do MCP, ou seja, os commits que estão em
  `d73eecc` e ainda não estão em `dev`:
  - `9e0e81a` feat(tokens): alcance (painel inteiro ou projetos escolhidos) no armazenamento de tokens
  - `604baad` feat(tokens): alcance por projeto na política de rotas, plugin de autenticação e rotas de projeto
  - `0d1f0ac` test(tokens): matriz rota × alcance contra o painel real
  - `00eb110` test(tokens): testes com handler real para listas filtradas, criação atômica de projeto, máscaras e gestão de alcance
  - `cc03082` feat(web): seletor de alcance, linha de alcance por token e editor da lista de projetos na tela Acesso por IA
  - `d73eecc` docs(tokens): alcance por projeto no SECURITY, guias, changelog, roadmap e comoFuncionaSistema
- Pela memória do projeto, o esperado de um revisor aqui é: build, typecheck,
  testes e `test:coverage --no-bail` de todos os pacotes (o CI reprova por
  mínimo de ramos), além de ler o diff procurando falhas de autorização.
- **Não confirmado**: se o brief pedia só leitura (provável, pois é revisão)
  ou correções.

## 2. O que já foi verificado

Praticamente nada.

- `git worktree list` (rodado no repositório principal): a cópia
  `.../scratchpad/rev-mcp0b` aparece em `d73eecc` (detached HEAD) como
  **prunable**, ou seja, a pasta já não existe. O diretório scratchpad estava
  vazio quando conferi.
- O `pnpm build` de `packages/core` acabou rodando **no repositório principal**
  (branch `dev`, em `33080ce`), porque o `cd` para a cópia falhou. Por isso
  **não vale como evidência da fase 0b**. A saída parou em `tsc -p tsconfig.json`
  e não mostrou erro nas linhas que vi.
- Não li nenhum arquivo do diff da fase 0b.

## 3. Achados

Nenhum achado de código, porque o diff ainda não foi lido.

Problema de processo: a cópia de revisão `rev-mcp0b` sumiu, mas continua
registrada no git como worktree "prunable". Severidade baixa: não afeta o
código, só deixa um registro órfão.

## 4. O que falta fazer, na ordem

1. Limpar o registro órfão e recriar a cópia de revisão:
   ```
   cd /home/kelvin/projects/paas
   git worktree prune
   git worktree add --detach <pasta-de-trabalho>/rev-mcp0b d73eecc
   cd <pasta-de-trabalho>/rev-mcp0b && pnpm install --frozen-lockfile
   ```
2. Fazer o build e o typecheck de tudo: `pnpm -r build` e depois
   `pnpm -r typecheck` (antes, confirme no `package.json` da raiz como os
   scripts se chamam).
3. Rodar os testes com cobertura em todos os pacotes:
   `pnpm -r test:coverage -- --no-bail`, e conferir se os mínimos de ramos
   passam.
4. Ler o diff: `git diff 33080ce...d73eecc`. Pontos para olhar com atenção:
   - Um token com alcance "projetos escolhidos" pode chegar a algum projeto
     fora da lista? Conferir listagens, rotas por id, rotas aninhadas
     (domínios, deploy, terminal, logs, backups) e WebSocket/SSE.
   - Criar um projeto com token restrito: o novo projeto entra no alcance de
     forma atômica, sem uma janela em que fique de fora ou que outro token o
     enxergue?
   - A troca de alcance de um token vale na hora, sem cache?
   - O que acontece quando um projeto da lista é apagado, ou quando a lista
     fica vazia (deve negar tudo, não liberar tudo)?
   - Rotas só de admin (domínios, portas, webmail) continuam bloqueadas para
     token, qualquer que seja o alcance.
   - As máscaras e a auditoria não vazam nomes ou ids de projetos fora do
     alcance.
   - A tela web mostra o alcance do mesmo jeito que a regra do servidor
     aplica, e a documentação descreve o comportamento real.
5. Escrever o veredito com os achados (severidade + cenário de falha).

## 5. Cópias de trabalho e processos a limpar

- `.../scratchpad/rev-mcp0b`: a pasta não existe mais, mas o registro no git
  continua. Limpar com `git worktree prune` no repositório principal.
- `/home/kelvin/projects/paas/.claude/worktrees/agent-afa2e8e7957c923a4`:
  branch `worktree-agent-afa2e8e7957c923a4`, em `d73eecc`. Tudo indica que é a
  cópia do agente que **implementou** a fase 0b, e não a minha. Não mexer sem
  confirmar com o coordenador.
- Nenhum processo em segundo plano foi iniciado por mim.

## 6. Veredito provisório

**Nenhum.** O diff não foi lido e os testes não rodaram na cópia certa, então
não há base para aprovar nem para reprovar.
