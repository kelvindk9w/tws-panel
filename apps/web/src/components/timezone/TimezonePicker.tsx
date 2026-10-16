/**
 * Seletor de fuso horário (Configurações → Fuso horário, assistente de
 * instalação e o campo "Fuso horário" do projeto): busca pelo nome do fuso
 * ou pela cidade, os do Brasil primeiro, cada um com o deslocamento de agora.
 */
import { useMemo } from "react";
import type { TimezoneOption } from "@paas/core";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";

/** "America/Sao_Paulo" → "America/Sao Paulo" (o nome continua o oficial). */
export function zoneLabel(zone: string): string {
  return zone.replace(/_/g, " ");
}

/** Texto de um fuso na lista: nome, onde vale (Brasil) e o deslocamento. */
export function optionLabel(o: TimezoneOption): string {
  return `${zoneLabel(o.zone)}${o.place ? ` — Brasil: ${o.place}` : ""}`;
}

/** "America/Sao_Paulo (UTC−3)" para frases. */
export function zoneWithOffset(zone: string, options: TimezoneOption[]): string {
  const offset = options.find((o) => o.zone === zone)?.offset;
  return offset && offset !== zone ? `${zone} (${offset})` : zone;
}

/** Hora de agora num fuso, ex.: "14:05". */
export function clockIn(zone: string, at: Date): string {
  try {
    return at.toLocaleTimeString("pt-BR", { timeZone: zone, hour: "2-digit", minute: "2-digit" });
  } catch {
    return at.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }
}

export function TimezonePicker({
  options,
  value,
  onChange,
  disabled,
  id,
  "aria-label": ariaLabel = "Fuso horário",
}: {
  options: TimezoneOption[];
  value: string;
  onChange: (zone: string) => void;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
}) {
  const items = useMemo<ComboboxOption[]>(
    () => options.map((o) => ({ value: o.zone, label: optionLabel(o), ...(o.offset ? { hint: o.offset } : {}) })),
    [options],
  );
  return (
    <Combobox
      options={items}
      value={value}
      onChange={onChange}
      disabled={disabled}
      id={id}
      aria-label={ariaLabel}
      placeholder="Busque pela cidade ou pelo nome do fuso"
    />
  );
}
