# Como retomar o trabalho em uma sessão nova

Depois de formatar o computador e clonar o repositório (ver `LEIA-ME-PRIMEIRO.md`, seção 9), rode **um único comando** no terminal. Ele entra na branch da transição e abre o Claude Code já com as instruções iniciais:

```bash
cd ~/projects/paas && git fetch origin && git checkout handoff/2026-10-23 && claude "Você está retomando um trabalho em andamento no TWS Panel. Leia por inteiro, nesta ordem: handoff/LEIA-ME-PRIMEIRO.md, handoff/validacoes-pendentes.md, handoff/plano-mcp.md e os relatórios em handoff/agentes/. Recrie as memórias do projeto a partir de handoff/memoria/ em ~/.claude/projects/-home-kelvin-projects-paas/memory/ (se ainda não existirem). Responda sempre em português com acentuação correta. Depois siga a seção 0 e a seção 7 do LEIA-ME: confira o estado do repositório e do PR #105 (gh pr view 105), diga em poucas linhas o que entendeu e proponha a próxima ação. A primeira tarefa pendente é rever a Fase 0b (branch mcp-fase-0b) disparando um revisor Opus com o prompt handoff/prompts/revisor-fase-0b.md. Regras: um subagente por assunto; sem Docker, sem navegador, sem servidores longos; nada de comandos contra a VPS do Kelvin (só para ele executar); não repita passos que ele já fez; não cole código no chat."
```

Se o `claude` não estiver instalado ainda, instale o Claude Code primeiro e rode o mesmo comando.

## Se a branch `handoff/2026-10-23` não existir mais

O Kelvin pode ter mesclado ou apagado a branch. Nesse caso use `git log --all --oneline -- handoff/` para achar o commit, ou peça a ele o caminho.

## Quando terminar a transição

Apague a pasta `handoff/` em um commit próprio (ela existe só para esta passagem de bastão) e a branch `handoff/2026-10-23` no GitHub.
