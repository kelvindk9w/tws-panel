import { cloneElement, Fragment, isValidElement, useCallback, useMemo, useSyncExternalStore, type ReactElement, type ReactNode } from "react";
import { getLocale, interpolate, setLocale, subscribe, translate, translateRaw, type Params } from "./core";
import type { Key } from "./keys";

export type TFunction = (key: Key, params?: Params) => string;

/** Tradução fora de componentes (libs, módulos): lê o idioma atual no momento da chamada. */
export const t: TFunction = (key, params) => translate(key, params);

/**
 * Hook da interface: reage à troca de idioma. Todo componente com texto usa
 * `const { t } = useI18n()`.
 */
export function useI18n() {
  const locale = useSyncExternalStore(subscribe, getLocale, getLocale);
  // depende do idioma para que `t` mude de identidade quando ele muda
  const tl = useCallback<TFunction>((key, params) => translate(key, params, locale), [locale]);
  return useMemo(() => ({ t: tl, locale, setLocale }), [tl, locale]);
}

export type RichComponents = Record<string, ReactElement | ((children: ReactNode) => ReactNode)>;

const TAG = /<(\w+)>([\s\S]*?)<\/\1>/g;

/**
 * Texto com marcação simples: `Veja <b>isto</b> e <code>{valor}</code>`. As
 * tags são lidas no texto da TRADUÇÃO, antes de qualquer valor entrar; os
 * `params` são inseridos depois, só como texto, dentro de cada trecho. Assim um
 * valor vindo de terceiros (nome de projeto, título de chat) nunca vira
 * marcação. Cada tag vira o elemento de `components` (`{ b: <strong /> }`) ou o
 * retorno da função recebida; sem a tag correspondente, sai o conteúdo puro.
 */
export function renderRich(raw: string, components: RichComponents, params?: Params): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of raw.matchAll(TAG)) {
    if (m.index > last) out.push(interpolate(raw.slice(last, m.index), params));
    const tag = m[1]!;
    const children = renderRich(m[2]!, components, params);
    const comp = components[tag];
    if (typeof comp === "function") out.push(<Fragment key={n++}>{comp(children)}</Fragment>);
    else if (isValidElement(comp)) out.push(cloneElement(comp, { key: n++ }, ...children));
    else out.push(<Fragment key={n++}>{children}</Fragment>);
    last = m.index + m[0].length;
  }
  if (last < raw.length) out.push(interpolate(raw.slice(last), params));
  return out;
}

/** `<Trans k="ns.chave" params={{ n: 3 }} components={{ b: <strong /> }} />` */
export function Trans({ k, params, components = {} }: { k: Key; params?: Params; components?: RichComponents }) {
  const { locale } = useI18n();
  return <>{renderRich(translateRaw(k, params, locale), components, params)}</>;
}
