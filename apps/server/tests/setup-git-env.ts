/**
 * setup-git-env.ts — nenhum teste alcança o repositório real pelo ambiente.
 *
 * Um hook de git (ou um worktree) exporta GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE etc. Os testes que criam
 * repositórios temporários e chamam o git herdariam isso e commitariam no repositório do painel. Aqui todas
 * as variáveis GIT_* saem do ambiente antes de qualquer teste (GIT_EXEC_PATH fica: diz onde o git instalado
 * guarda os próprios programas). Os testes que precisam de uma delas (GIT_ASKPASS, GIT_SSL_CAINFO) a definem
 * por conta própria depois.
 */
for (const name of Object.keys(process.env)) {
  if (name.startsWith("GIT_") && name !== "GIT_EXEC_PATH") delete process.env[name];
}
