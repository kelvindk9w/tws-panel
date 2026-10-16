# Como regenerar os prints do README

Os arquivos `docs/imagens/*.png` são capturas do painel (`apps/web`, Vite) com a API simulada
pelo Playwright. Os dados são fictícios: `exemplo.com.br`, IP `203.0.113.10`, usuário `admin`.

- `capturar.mjs`: abre cada tela, responde a `/api/**` com dados fictícios e salva os PNGs.
  No fim, lista os endpoints que a tela pediu e não estão simulados.
- `otimizar.py`: reduz os PNGs para 256 cores (Pillow) e copia para a pasta de destino.

Trabalhe **fora do repositório**: o `pnpm install` na raiz roda o `prepare`, que mexe no
`core.hooksPath` do git. Nos comandos, `S` é uma pasta de trabalho qualquer e `WT` é o checkout
do repositório.

1. Cópia do código e dependências do web:

   ```bash
   mkdir -p $S/repo $S/shots $S/browsers
   git -C $WT archive HEAD | tar -x -C $S/repo
   cd $S/repo && pnpm install --ignore-scripts --filter "@paas/web..."
   ```

2. Scripts de captura, `playwright-core` e Chromium:

   ```bash
   cp $WT/docs/imagens/regenerar/{capturar.mjs,otimizar.py,package.json} $S/shots/
   cd $S/shots && npm install
   PLAYWRIGHT_BROWSERS_PATH=$S/browsers npx playwright-core install chromium
   ```

3. Vite (deixe rodando em outro terminal):

   ```bash
   cd $S/repo/apps/web && npx vite --port 5199 --strictPort
   ```

4. Capturar:

   ```bash
   cd $S/shots && PLAYWRIGHT_BROWSERS_PATH=$S/browsers node capturar.mjs ./out http://localhost:5199
   ```

5. Otimizar e copiar para o repositório (precisa do Pillow: `pip install pillow`):

   ```bash
   python3 $S/shots/otimizar.py $S/shots/out $WT/docs/imagens
   ```

Confira cada imagem antes de commitar: nenhuma tela com erro, carregando ou vazia, e nenhum dado
real. Se uma tela nova pedir um endpoint que não está simulado, acrescente a resposta em
`capturar.mjs`.
