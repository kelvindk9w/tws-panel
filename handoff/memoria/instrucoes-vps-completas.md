---
name: instrucoes-vps-completas
description: "toda instrução para a VPS vem completa — onde entrar, pasta exata, comandos na ordem, como conferir"
metadata:
  node_type: memory
  type: feedback
  originSessionId: e34c520e-bac4-4c56-b13e-bff7bba4ef19
  modified: 2026-10-01T14:57:53.698Z
---

Instrução para o Kelvin executar (VPS, GitHub, painel) sempre completa e autossuficiente: como
entrar (SSH com o usuário dele), a pasta exata (`cd /opt/tws-panel`; projetos em
`/opt/tws-projects`), cada comando na ordem, com ou sem sudo, onde clicar no GitHub/painel e como
conferir que deu certo. Nunca "na pasta do painel" sem dizer qual é.

**Why:** ele pediu explicitamente (01/10/2026) depois de eu escrever "na pasta do painel" sem o
caminho; ele segue o README como um leigo, sem ajudante de IA.

**How to apply:** atualizar o painel = UMA linha encadeada (formato que ele prefere):
`cd /opt/tws-panel && sudo git pull && sudo git log --oneline -1 && sudo docker compose up -d --build`
(na VPS dele /opt/tws-panel é do root: `git pull` sem sudo dá "index file open failed:
Permission denied" — visto em 01/10/2026). Antes de mandar outros passos, conferir no README o
caminho/comando oficial. Relacionado: [[pedido-explicito-nao-reduzir]].
