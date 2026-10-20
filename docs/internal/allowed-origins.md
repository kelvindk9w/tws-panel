# ALLOWED_ORIGINS: painel atrás de outro proxy

O painel recusa com `403 forbidden_origin` toda requisição de escrita (POST, PUT, PATCH, DELETE)
que o navegador diga vir de outro site ou outra origem (guarda contra CSRF, lote 7). A decisão usa
os cabeçalhos `Sec-Fetch-Site` e `Origin`. Atrás do proxy Caddy que o próprio painel instala isso
funciona sem configurar nada.

Se você coloca **outro proxy na frente** (um balanceador, um túnel, um CDN) que remove o
`Sec-Fetch-Site` ou reescreve o `Origin`, as ações do painel passam a voltar `403 forbidden_origin`.
Para liberar a origem exata em que a página é aberta:

1. Edite o `.env` da instalação (padrão `/opt/tws-panel/.env`) e acrescente, separando várias por
   vírgula e sem barra no fim:

   ```
   ALLOWED_ORIGINS=https://painel.exemplo.com
   ```

2. Recrie o container para ele ler a variável:

   ```bash
   cd /opt/tws-panel && sudo docker compose up -d
   ```

O `docker-compose.yml` repassa `ALLOWED_ORIGINS` ao container (vazio por padrão, que mantém o
comportamento de sempre: só a própria origem). A mesma lista também é a das origens aceitas pela
CORS da API; só as origens escritas ali ganham essa liberação.

Não use `*`: a comparação é exata, origem por origem.
