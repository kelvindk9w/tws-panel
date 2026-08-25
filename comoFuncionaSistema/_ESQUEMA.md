# Esquema da documentação `comoFuncionaSistema/`

Documentação legível por máquina do TWS Panel, destinada a **agentes de IA** que
precisam entender o sistema sem reler todo o código.

## Estrutura

```
comoFuncionaSistema/
  _ESQUEMA.md          este arquivo (contrato dos JSONs)
  index.json           visão geral: stack, módulos, ponto de entrada de cada um
  global/
    index.json         índice das peças globais/reutilizáveis
    <peca>.json        uma peça global por arquivo (com "usadoPor")
  <modulo>/
    index.json         resumo do módulo + lista de endpoints -> arquivo
    <acao>.json        um endpoint por arquivo, detalhado
```

Regras gerais:
- Nomes de diretório e de arquivo em **kebab-case, português**.
- Todo caminho de código citado é **relativo à raiz do repositório** e usa
  `caminho/arquivo.ts:linha` quando aponta para um símbolo específico.
- Nunca inventar: se algo não existe ou não foi verificado, usar `null` ou
  registrar em `observacoes`.
- JSON puro (sem comentários), UTF-8, indentação de 2 espaços.

## 1. `index.json` (raiz)

```json
{
  "sistema": "TWS Panel",
  "descricao": "...",
  "versao": "0.1.0",
  "atualizadoEm": "2026-08-24",
  "stack": { "runtime": "...", "servidor": "...", "frontend": "...", "gerenciadorPacotes": "...", "testes": "..." },
  "estruturaRepositorio": [ { "caminho": "apps/server", "papel": "..." } ],
  "modulos": [
    {
      "id": "autenticacao",
      "titulo": "Autenticação",
      "resumo": "Uma a três frases: o que este módulo faz no sistema.",
      "pontoDeEntrada": { "api": "POST /api/auth/login", "web": "/login" },
      "indice": "autenticacao/index.json",
      "arquivosPrincipais": ["apps/server/src/routes/auth.ts"]
    }
  ],
  "global": { "indice": "global/index.json", "resumo": "..." },
  "estadoAtual": "global/estado-atual.json"
}
```

## 2. `<modulo>/index.json`

```json
{
  "modulo": "autenticacao",
  "titulo": "Autenticação",
  "resumo": "...",
  "pontoDeEntrada": { "api": "POST /api/auth/login", "web": "/login" },
  "comoFunciona": ["passo alto nível 1", "passo 2"],
  "arquivosFonte": {
    "rotas": ["apps/server/src/routes/auth.ts"],
    "servicos": ["apps/server/src/services/user-store.ts"],
    "pacotes": ["packages/core/src/auth.ts"],
    "web": ["apps/web/src/pages/LoginPage.tsx"],
    "testes": ["apps/server/tests/auth.test.ts"]
  },
  "persistencia": [{ "arquivo": "data/users.json", "formato": "json", "conteudo": "..." }],
  "endpoints": [
    { "id": "login", "metodo": "POST", "url": "/api/auth/login", "resumo": "...", "arquivo": "login.json" }
  ],
  "dependenciasGlobais": ["global/auth-plugin.json"],
  "pontosDeAtencao": ["..."]
}
```

## 3. `<modulo>/<acao>.json` — um endpoint

```json
{
  "id": "login",
  "modulo": "autenticacao",
  "metodo": "POST",
  "url": "/api/auth/login",
  "resumo": "...",
  "arquivoFonte": "apps/server/src/routes/auth.ts:32",
  "autenticacao": { "exigida": true, "tipo": "sessao|setup-token|publica|websocket", "detalhe": "..." },
  "rateLimit": "...ou null",
  "parametros": {
    "path": [{ "nome": "id", "tipo": "string", "obrigatorio": true, "descricao": "..." }],
    "query": [],
    "body": [{ "nome": "password", "tipo": "string", "obrigatorio": true, "regras": "...", "descricao": "..." }],
    "headers": []
  },
  "respostas": [
    { "status": 200, "quando": "...", "corpo": { "ok": "boolean" }, "exemplo": {} }
  ],
  "erros": [
    { "status": 401, "codigo": "invalid_credentials", "quando": "...", "mensagem": "..." }
  ],
  "fluxo": ["1. ...", "2. ..."],
  "dependencias": [
    { "tipo": "servico|pacote|global", "nome": "UserStore", "arquivo": "apps/server/src/services/user-store.ts", "papel": "..." }
  ],
  "efeitosColaterais": ["grava data/sessions.json", "auditoria: login_success"],
  "chamadoPor": ["apps/web/src/lib/api.ts:login", "apps/web/src/pages/LoginPage.tsx"],
  "testes": ["apps/server/tests/auth.test.ts"],
  "observacoes": []
}
```

## 4. `global/<peca>.json`

```json
{
  "id": "auth-plugin",
  "titulo": "Plugin de autenticação (guarda global)",
  "resumo": "...",
  "arquivoFonte": "apps/server/src/plugins/auth.ts",
  "tipo": "middleware|servico|utilitario|configuracao|infraestrutura",
  "api": [
    { "simbolo": "requireSession", "assinatura": "(request, reply) => Promise<void>", "descricao": "..." }
  ],
  "comportamento": ["..."],
  "usadoPor": [
    { "referencia": "POST /api/projects", "arquivo": "apps/server/src/routes/projects.ts:43", "doc": "projetos/criar.json" }
  ],
  "testes": ["..."],
  "observacoes": []
}
```
