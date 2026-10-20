# Relatório — vulnerabilidades de dependências

Origem: `gh api .../dependabot/alerts` (10 abertos) e `pnpm audit` (14 avisos; o audit conta cada advisory do undici separadamente).

## Alertas -> ação -> resultado

| Alertas | Pacote | Severidade | Relação / escopo | Ação | Resultado |
|---|---|---|---|---|---|
| 53, 55, 56, 57, 60, 61, 62 | undici 8.10.0 | 3 altas/moderadas, 3 baixas | transitiva (vitest > jsdom), só desenvolvimento | `pnpm.overrides`: `undici ^8.10.2` | corrigido (mesma major, patch) |
| 84 | source-map-js 1.2.1 | alta | transitiva (coverage-v8 > magicast; vite > postcss), só desenvolvimento | override `^1.2.2` | corrigido (patch) |
| 83 | postcss-selector-parser 6.1.4 | moderada | transitiva (tailwindcss 3 > postcss-nested), build do web | override `^7.1.6` | corrigido; build do web e testes passam |
| 82 | braces 3.0.3 | alta | transitiva (tailwindcss > chokidar/micromatch), só build do web | nenhuma | NÃO corrigível: o advisory marca `<=3.0.3` sem versão corrigida, e 3.0.3 é a última publicada |

## O que sobrou e por quê

Só o `braces` (alerta 82, DoS por estouro de pilha com padrões aninhados). Não há versão corrigida a instalar. Mitigação: o pacote só entra via tailwindcss 3 (chokidar/micromatch) na compilação do CSS do web, com padrões vindos do próprio repositório (`content` do tailwind), nunca de entrada de usuário, e não vai para a imagem de produção em tempo de execução. Risco prático praticamente nulo. Acompanhar: sair quando o advisory ganhar versão corrigida ou ao migrar para Tailwind 4 (que não usa chokidar 3). Alerta não foi dispensado.

## Risco de cada atualização

- undici: patch dentro da major 8 usada pelo jsdom; só testes. Baixo.
- source-map-js: patch 1.2.1 -> 1.2.2. Baixo.
- postcss-selector-parser: salto de major (6 -> 7) forçado em dependência do tailwind 3 (postcss-nested). Foi o único com risco real; o build do web gerou o CSS normalmente (48,9 kB) e os testes passaram, mas não houve conferência visual do CSS. Médio-baixo; se aparecer regressão de estilo, remover este override (o alerta 83 volta).

## Verificação feita

- `pnpm install --frozen-lockfile`: ok. `pnpm -r run typecheck` e `pnpm -r run build`: ok.
- `test:coverage` em todos os pacotes (server com `--maxWorkers=2`), sem bail: todos passaram, sem violação de mínimos.
- `docker build` da imagem do painel: ok (imagem de teste removida depois).
- `pnpm audit` depois: 1 aviso (braces).
- Dockerfile: base `node:22-bookworm-slim` fixada por digest; digest NÃO alterado.

## NÃO testado

- trivy: não está instalado aqui; o `image-scan` do CI não foi reproduzido (CVEs do SO/Node da imagem base não avaliados).
- Aparência real do front (CSS gerado com postcss-selector-parser 7) não foi comparada visualmente nem testada em navegador.
- A imagem construída não foi executada (subida do painel).
- Os alertas do GitHub só fecham após o merge e nova varredura do Dependabot na branch padrão.
