import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageSelect } from "../src/components/LanguageSelect";
import {
  apiErrorText,
  catalog,
  compareText,
  detectLocale,
  formatDate,
  formatDateTime,
  formatNumber,
  getLocale,
  hasKey,
  initLocale,
  renderRich,
  setLocale,
  STORAGE_KEY,
  supportedLocales,
  t,
  Trans,
  translate,
  useI18n,
} from "../src/i18n";
import { ApiRequestError } from "../src/lib/api";

function stubBrowserLanguages(langs: string[]) {
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(langs);
  vi.spyOn(window.navigator, "language", "get").mockReturnValue(langs[0] ?? "");
}

afterEach(() => {
  cleanup(); // desmonta antes de tirar os dicionários de teste
  vi.restoreAllMocks();
  // dicionários de teste
  for (const loc of Object.keys(catalog)) delete catalog[loc]?.["t_"];
  delete catalog["es"];
});

describe("detecção do idioma", () => {
  it("pt* vira pt-BR, qualquer outro vira en", () => {
    expect(detectLocale(null, ["pt-PT"])).toBe("pt-BR");
    expect(detectLocale(null, ["pt"])).toBe("pt-BR");
    expect(detectLocale(null, ["pt-BR", "en-US"])).toBe("pt-BR");
    expect(detectLocale(null, ["en-US"])).toBe("en");
    expect(detectLocale(null, ["de-DE", "ja"])).toBe("en");
    expect(detectLocale(null, [])).toBe("en");
  });

  it("a preferência guardada vence o navegador; valor desconhecido é ignorado", () => {
    expect(detectLocale("en", ["pt-BR"])).toBe("en");
    expect(detectLocale("pt-BR", ["en-US"])).toBe("pt-BR");
    expect(detectLocale("klingon", ["pt-BR"])).toBe("pt-BR");
  });

  it("um idioma novo em src/locales é escolhido sem mexer no código (es por exemplo)", () => {
    catalog["es"] = { common: { "language.name": "Español" } };
    expect(supportedLocales()).toContain("es");
    expect(detectLocale(null, ["es-MX"])).toBe("es");
    expect(detectLocale(null, ["fr"])).toBe("en");
  });

  it("initLocale lê o navegador na primeira visita e a preferência depois", () => {
    stubBrowserLanguages(["en-GB"]);
    expect(initLocale()).toBe("en");
    expect(document.documentElement.lang).toBe("en");

    window.localStorage.setItem(STORAGE_KEY, "pt-BR");
    expect(initLocale()).toBe("pt-BR");
  });

  it("initLocale funciona com o armazenamento indisponível", () => {
    stubBrowserLanguages(["pt-BR"]);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(initLocale()).toBe("pt-BR");
  });
});

describe("escolha e persistência", () => {
  it("setLocale guarda a escolha e idioma desconhecido é ignorado", () => {
    setLocale("en");
    expect(getLocale()).toBe("en");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("en");
    setLocale("zz");
    expect(getLocale()).toBe("en");
  });

  it("persist: false não grava", () => {
    setLocale("en", { persist: false });
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("não quebra se o armazenamento recusar a gravação", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    setLocale("en");
    expect(getLocale()).toBe("en");
  });
});

describe("troca de idioma na interface", () => {
  function Sample() {
    const { t: tr } = useI18n();
    return (
      <div>
        <h1>{tr("common.language.label")}</h1>
        <LanguageSelect />
      </div>
    );
  }

  it("o seletor lista os idiomas pelo próprio nome e troca o texto na hora", async () => {
    const user = userEvent.setup();
    render(<Sample />);
    expect(screen.getByRole("heading")).toHaveTextContent("Idioma");
    const select = screen.getByRole("combobox", { name: "Idioma" });
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Português (Brasil)", "English"]);

    await user.selectOptions(select, "en");
    expect(screen.getByRole("heading")).toHaveTextContent("Language");
    expect(screen.getByRole("combobox", { name: "Language" })).toHaveValue("en");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("en");
    expect(document.documentElement.lang).toBe("en");

    await user.selectOptions(screen.getByRole("combobox"), "pt-BR");
    expect(screen.getByRole("heading")).toHaveTextContent("Idioma");
  });
});

describe("tradução", () => {
  beforeEach(() => {
    catalog["pt-BR"]!["t_"] = {
      hello: "Olá, {name}!",
      "items_one": "{count} item",
      "items_other": "{count} itens",
      onlyPt: "Só em português",
      rich: "Veja <b>isto</b> e <code>{v}</code>",
    };
    catalog["en"]!["t_"] = {
      hello: "Hello, {name}!",
      "items_one": "{count} item",
      "items_other": "{count} items",
      rich: "See <b>this</b> and <code>{v}</code>",
    };
  });

  it("interpola variáveis e mantém a chave `{x}` quando falta o valor", () => {
    expect(translate("t_.hello", { name: "Ana" })).toBe("Olá, Ana!");
    expect(translate("t_.hello")).toBe("Olá, {name}!");
    setLocale("en");
    expect(t("t_.hello" as never, { name: "Ana" })).toBe("Hello, Ana!");
  });

  it("plural segue o idioma", () => {
    expect(translate("t_.items", { count: 1 })).toBe("1 item");
    expect(translate("t_.items", { count: 3 })).toBe("3 itens");
    expect(translate("t_.items", { count: 0 }, "en")).toBe("0 items");
    expect(hasKey("t_.items")).toBe(true);
  });

  it("chave ausente no idioma cai para pt-BR; ausente em todos devolve a chave e avisa", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setLocale("en");
    expect(translate("t_.onlyPt")).toBe("Só em português");
    expect(hasKey("t_.onlyPt")).toBe(false);
    expect(translate("t_.nope")).toBe("t_.nope");
    expect(translate("t_.nope")).toBe("t_.nope");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("renderRich / Trans montam a marcação com os componentes", () => {
    render(
      <p data-testid="p">
        <Trans k={"t_.rich" as never} params={{ v: "x" }} components={{ b: <strong />, code: (c) => <code>{c}</code> }} />
      </p>,
    );
    expect(screen.getByTestId("p").innerHTML).toBe("Veja <strong>isto</strong> e <code>x</code>");
    expect(renderRich("a <u>b</u>", {}).length).toBe(2);
  });
});

describe("erros da API", () => {
  beforeEach(() => {
    catalog["pt-BR"]!["errors"] = { ...catalog["pt-BR"]!["errors"], "code.x_code": "Texto pt do código" };
    catalog["en"]!["errors"] = { ...catalog["en"]!["errors"], "code.x_code": "English text for the code" };
  });
  afterEach(() => {
    delete catalog["pt-BR"]!["errors"]!["code.x_code"];
    delete catalog["en"]!["errors"]!["code.x_code"];
  });

  it("em pt-BR vale a mensagem do servidor", () => {
    expect(apiErrorText(new ApiRequestError(400, "x_code", "Mensagem do servidor"), "common.language.label")).toBe("Mensagem do servidor");
  });

  it("em outro idioma, o code estável vira o texto traduzido", () => {
    setLocale("en");
    expect(apiErrorText(new ApiRequestError(400, "x_code", "Mensagem do servidor"), "common.language.label")).toBe(
      "English text for the code",
    );
  });

  it("sem tradução do code, a mensagem do servidor é o fallback; sem mensagem, o texto padrão", () => {
    setLocale("en");
    expect(apiErrorText(new ApiRequestError(400, "outro", "Mensagem do servidor"), "common.language.label")).toBe("Mensagem do servidor");
    expect(apiErrorText(new ApiRequestError(400, "outro", ""), "common.language.label")).toBe("Language");
    expect(apiErrorText(new Error("erro local"), "common.language.label")).toBe("Language");
    expect(apiErrorText("x", "common.language.label")).toBe("Language");
    setLocale("pt-BR");
    expect(apiErrorText(new Error("erro local"), "common.language.label")).toBe("erro local");
  });
});

describe("formatação pelo idioma", () => {
  const date = new Date(Date.UTC(2026, 9, 20, 15, 30));

  it("datas, números e ordenação seguem o idioma e respeitam o fuso informado", () => {
    expect(formatDate(date, { timeZone: "UTC" })).toBe("20/10/2026");
    expect(formatDateTime(date, { timeZone: "UTC", dateStyle: "short", timeStyle: "short" })).toMatch(/^20\/10\/2026,? 15:30$/);
    expect(formatNumber(1234.5)).toBe("1.234,5");
    expect(compareText("ä", "z")).toBeLessThan(0);

    setLocale("en");
    expect(formatDate(date, { timeZone: "UTC" })).toBe("10/20/2026");
    expect(formatDateTime(date, { timeZone: "UTC", dateStyle: "short", timeStyle: "short" })).toMatch(/^10\/20\/26, 3:30\s?PM$/);
    expect(formatNumber(1234.5)).toBe("1,234.5");
  });

  it("o fuso escolhido muda a hora em qualquer idioma", () => {
    const sp = formatDateTime(date, { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", hour12: false });
    expect(sp).toBe("12:30");
    setLocale("en");
    expect(formatDateTime(date, { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", hour12: false })).toBe("12:30");
  });
});
