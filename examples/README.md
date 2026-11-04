# Exemplos

> ⚠️ **APENAS PARA TESTES.** Estes apps existem para exercitar os pipelines de deploy e os
> guardrails do painel em ambiente de desenvolvimento. **Não use em produção** — as senhas e
> configurações aqui são triviais e públicas, e o `compose-app` expõe propositalmente uma porta
> de banco no host para disparar o guardrail `db-port-exposed`.

| Exemplo | Pipeline detectado | O que demonstra |
|---|---|---|
| [`static-site/`](static-site/) | `static-node` | Build Node que gera `out/` servido como estático atrás do Caddy (perfil "bomb"). |
| [`compose-app/`](compose-app/) | `compose` (adotado) | Compose existente que o painel **não reescreve** — só anexa o override da rede `paas-net` (perfil "trader"). Contém um warning de guardrail **proposital**: Redis publicado no host. |

## Como usar

1. Rode o painel em modo dev (`SETUP_TOKEN=dev-token pnpm dev`);
2. Cadastre um projeto com ingestão **upload/diretório** apontando para uma dessas pastas;
3. Use um domínio `.localhost` (ex.: `static.localhost`);
4. Faça o deploy e observe: detecção do pipeline, relatório de guardrails (o `compose-app`
   deve gerar alerta sobre o Redis), geração do Caddyfile e health check.
