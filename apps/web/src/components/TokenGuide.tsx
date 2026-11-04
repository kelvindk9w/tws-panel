import { useState } from "react";
import { BookOpen, ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { Trans, useI18n } from "@/i18n";

/** "dono/repositório" de uma URL do GitHub (https ou .git), ou null. */
function githubRepo(url: string): string | null {
  const m = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

function isGitLab(url: string): boolean {
  return /gitlab\./i.test(url);
}

const GITHUB_NEW_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";

/**
 * "Como gerar o token" do repositório privado. O guia sai da URL colada: no
 * GitHub (o caminho validado pelo painel), passo a passo com link direto e o
 * nome do repositório; em outros provedores, a orientação geral — sem prometer
 * telas que o painel não conferiu.
 */
export function TokenGuide({ url = "", scope = "repo" }: { url?: string; scope?: "repo" | "account" }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const repo = scope === "repo" ? githubRepo(url) : null;
  const gitlab = scope === "repo" && !repo && isGitLab(url);

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 self-start text-xs font-medium text-sky-400 hover:underline"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <BookOpen className="h-3.5 w-3.5" /> {t("setup.tokenGuide.toggle")}
      </button>

      {open && (
        <div data-testid="token-guide" className="flex flex-col gap-2 rounded-md border bg-background/60 p-3 text-xs text-muted-foreground">
          {repo || !gitlab ? (
            <>
              <a
                href={GITHUB_NEW_TOKEN_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 self-start font-medium text-sky-400 hover:underline"
              >
                {t("setup.tokenGuide.openGithub")} <ExternalLink className="h-3 w-3" />
              </a>
              <ol className="flex list-decimal flex-col gap-1.5 pl-4">
                <li>
                  <Trans k="setup.tokenGuide.step1" components={{ em: <em />, b: <strong className="text-foreground" /> }} />
                </li>
                <li>
                  <Trans k="setup.tokenGuide.step2" components={{ b: <strong className="text-foreground" /> }} />
                </li>
                {scope === "account" ? (
                  <li>
                    <Trans k="setup.tokenGuide.step3Account" components={{ b: <strong className="text-foreground" /> }} />
                  </li>
                ) : (
                  <li>
                    <Trans
                      k="setup.tokenGuide.step3Repo"
                      params={{ repo: repo ?? t("setup.tokenGuide.repoFallback") }}
                      components={{ b: <strong className="text-foreground" />, repo: <strong className="font-mono text-foreground" /> }}
                    />
                  </li>
                )}
                <li>
                  <Trans k="setup.tokenGuide.step4" components={{ b: <strong className="text-foreground" /> }} />
                </li>
                <li>
                  <Trans
                    k="setup.tokenGuide.step5"
                    components={{ b: <strong className="text-foreground" />, code: <code className="font-mono" /> }}
                  />
                </li>
              </ol>
            </>
          ) : (
            <>
              <p>
                <Trans
                  k="setup.tokenGuide.gitlab"
                  components={{
                    b: <strong className="text-foreground" />,
                    em: <em />,
                    code: <code className="font-mono text-foreground" />,
                  }}
                />
              </p>
              <p>
                {t("setup.tokenGuide.otherProviders")}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
