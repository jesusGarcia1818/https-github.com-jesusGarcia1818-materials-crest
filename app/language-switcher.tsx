"use client";

export type AppLanguage = "en" | "es";

type Props = {
  language: AppLanguage;
  onChange: (language: AppLanguage) => void;
};

export function LanguageSwitcher({ language, onChange }: Props) {
  return (
    <div className="language-switcher no-print" role="group" aria-label={language === "es" ? "Seleccionar idioma" : "Select language"}>
      <button type="button" className={language === "en" ? "active" : ""} aria-pressed={language === "en"} onClick={() => onChange("en")}>
        <span aria-hidden="true">🇺🇸</span> English
      </button>
      <button type="button" className={language === "es" ? "active" : ""} aria-pressed={language === "es"} onClick={() => onChange("es")}>
        <span aria-hidden="true">🇪🇸</span> Español
      </button>
    </div>
  );
}
