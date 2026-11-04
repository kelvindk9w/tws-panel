/**
 * Seletor de fuso horário (Configurações → Fuso horário, assistente de
 * instalação e o campo "Fuso horário" do projeto): busca pelo nome do fuso
 * ou pela cidade, os do Brasil primeiro, cada um com o deslocamento de agora.
 */
import { useMemo } from "react";
import type { TimezoneOption } from "@paas/core";
import { formatTime, t, useI18n } from "@/i18n";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";

/** "America/Sao_Paulo" → "America/Sao Paulo" (o nome continua o oficial). */
export function zoneLabel(zone: string): string {
  return zone.replace(/_/g, " ");
}

/** Texto de um fuso na lista: nome, onde vale (Brasil) e o deslocamento. */
export function optionLabel(o: TimezoneOption): string {
  return o.place ? t("timezone.picker.optionWithPlace", { zone: zoneLabel(o.zone), place: o.place }) : zoneLabel(o.zone);
}

/** "America/Sao_Paulo (UTC−3)" para frases. */
export function zoneWithOffset(zone: string, options: TimezoneOption[]): string {
  const offset = options.find((o) => o.zone === zone)?.offset;
  return offset && offset !== zone ? `${zone} (${offset})` : zone;
}

/** Hora de agora num fuso, ex.: "14:05". */
export function clockIn(zone: string, at: Date): string {
  try {
    return formatTime(at, { timeZone: zone, hour: "2-digit", minute: "2-digit" });
  } catch {
    return formatTime(at, { hour: "2-digit", minute: "2-digit" });
  }
}

export function TimezonePicker({
  options,
  value,
  onChange,
  disabled,
  id,
  "aria-label": ariaLabel,
}: {
  options: TimezoneOption[];
  value: string;
  onChange: (zone: string) => void;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
}) {
  const { t: tr } = useI18n();
  const items = useMemo<ComboboxOption[]>(
    () => options.map((o) => ({ value: o.zone, label: optionLabel(o), ...(o.offset ? { hint: o.offset } : {}) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `tr` muda com o idioma e refaz os rótulos
    [options, tr],
  );
  return (
    <Combobox
      options={items}
      value={value}
      onChange={onChange}
      disabled={disabled}
      id={id}
      aria-label={ariaLabel ?? tr("timezone.picker.ariaLabel")}
      placeholder={tr("timezone.picker.placeholder")}
    />
  );
}
