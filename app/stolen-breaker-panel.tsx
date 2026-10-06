"use client";

import { useEffect, useMemo, useState } from "react";
import type { AppLanguage } from "./language-switcher";

type Props = { language: AppLanguage; previewOnly?: boolean; onBack: () => void };
type MaterialLine = { description: string; code: string; quantity: number };
type AddressRecord = { address: string; status: string; outgoing: MaterialLine[]; returns: MaterialLine[] };
type PickupEntry = { address: string; workOrder: string; supervisor: string; serviceTechnician: string; date: string; itemCount: number; unitCount: number };

const previewRecord: AddressRecord = {
  address: "Preview address · local only", status: "PREVIEW",
  outgoing: [{ code: "CE0122", description: "SQD 30A 2P BREAKER", quantity: 1 }, { code: "CE0120", description: "SQD 20A 1P BREAKER", quantity: 2 }],
  returns: [],
};

function today() { const date = new Date(); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
function validRecord(value: unknown): value is AddressRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<AddressRecord>;
  return typeof record.address === "string" && typeof record.status === "string" && Array.isArray(record.outgoing) && Array.isArray(record.returns)
    && record.outgoing.every((item) => item && typeof item.description === "string" && typeof item.code === "string" && typeof item.quantity === "number" && item.quantity > 0);
}

export function StolenBreakerPanel({ language, previewOnly = false, onBack }: Props) {
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<AddressRecord[]>([]);
  const [selected, setSelected] = useState<AddressRecord | null>(null);
  const [workOrder, setWorkOrder] = useState("");
  const [supervisor, setSupervisor] = useState("");
  const [serviceTechnician, setServiceTechnician] = useState("");
  const [date, setDate] = useState(today());
  const [loading, setLoading] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [pickupList, setPickupList] = useState<PickupEntry[]>([]);
  const tx = (english: string, spanish: string) => language === "es" ? spanish : english;

  useEffect(() => {
    if (previewOnly) { setResults([previewRecord]); return; }
    const value = search.trim();
    if (value.length < 2) { setResults([]); setError(""); return; }
    let active = true;
    setLoading(true);
    const timer = window.setTimeout(() => {
      fetch(`/api/breaker-swap?resource=addresses&search=${encodeURIComponent(value)}`, { cache: "no-store" })
        .then(async (response) => ({ response, payload: await response.json().catch(() => null) }))
        .then(({ response, payload }) => {
          if (!response.ok || !Array.isArray(payload) || !payload.every(validRecord)) throw new Error(tx("The central address list is not available.", "La lista central de direcciones no está disponible."));
          if (active) { setResults(payload); setError(""); }
        })
        .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : tx("Addresses could not be loaded.", "No se pudieron cargar las direcciones.")); })
        .finally(() => { if (active) setLoading(false); });
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [search, previewOnly, language]);

  useEffect(() => {
    if (previewOnly) return;
    let active = true;
    fetch(`/api/breaker-swap?resource=stolen-pickups&date=${encodeURIComponent(date)}`, { cache: "no-store" })
      .then(async (response) => ({ response, payload: await response.json().catch(() => null) }))
      .then(({ response, payload }) => {
        if (!response.ok || !Array.isArray(payload)) throw new Error(tx("Saved pickups could not be loaded.", "No se pudieron cargar las recogidas guardadas."));
        if (active) setPickupList(payload as PickupEntry[]);
      })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : tx("Saved pickups could not be loaded.", "No se pudieron cargar las recogidas guardadas.")); });
    return () => { active = false; };
  }, [date, previewOnly, language]);

  const pickupItems = useMemo(() => selected?.outgoing ?? [], [selected]);
  const canPrint = Boolean(selected && pickupItems.length && /^\d+$/.test(workOrder) && supervisor.trim().length >= 2 && serviceTechnician.trim().length >= 2 && date && !printing);

  async function printPickup() {
    if (!selected || !canPrint) return;
    const windowRef = window.open("", "_blank");
    if (!windowRef) { setError(tx("Allow pop-ups to print the Material Pickup PDF.", "Permita las ventanas emergentes para imprimir el PDF de recogida de materiales.")); return; }
    windowRef.document.title = "Material Pickup";
    windowRef.document.body.textContent = tx("Preparing Material Pickup PDF…", "Preparando PDF de recogida de materiales…");
    setPrinting(true); setError(""); setSaved("");
    try {
      const { createBreakerSwapPdf } = await import("./lib/breaker-swap-pdf");
      const bytes = await createBreakerSwapPdf({
        address: selected.address, supervisor: supervisor.trim(), serviceTechnician: serviceTechnician.trim(), workOrder, swapDate: date, documentType: "stolen-pickup",
        items: pickupItems.map((item) => ({ category: "MATERIAL PICKUP", materialCode: item.code, itemNumber: "", lineNumber: "", description: item.description, quantity: item.quantity })),
      });
      if (!previewOnly) {
        const response = await fetch("/api/breaker-swap", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            operation: "stolen-pickup",
            pickup: {
              address: selected.address,
              supervisor: supervisor.trim(),
              serviceTechnician: serviceTechnician.trim(),
              workOrder,
              date,
              items: pickupItems.map((item) => ({ description: item.description, code: item.code, quantity: item.quantity })),
            },
          }),
        });
        const savedRecord = await response.json().catch(() => null) as { error?: string; requestCode?: string } | null;
        if (!response.ok) throw new Error(savedRecord?.error || tx("The Material Pickup could not be saved in the daily report.", "No se pudo guardar la recogida en el reporte diario."));
        setSaved(savedRecord?.requestCode
          ? tx(`Saved in the daily list as ${savedRecord.requestCode}.`, `Guardado en la lista diaria como ${savedRecord.requestCode}.`)
          : tx("Saved in the daily list.", "Guardado en la lista diaria."));
      }
      const pdfUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/pdf" }));
      const entry: PickupEntry = {
        address: selected.address,
        workOrder,
        supervisor: supervisor.trim(),
        serviceTechnician: serviceTechnician.trim(),
        date,
        itemCount: pickupItems.length,
        unitCount: pickupItems.reduce((total, item) => total + item.quantity, 0),
      };
      setPickupList((previous) => [entry, ...previous.filter((item) => !(item.address === entry.address && item.workOrder === entry.workOrder && item.date === entry.date))]);
      windowRef.addEventListener("load", () => window.setTimeout(() => windowRef.print(), 350), { once: true });
      windowRef.location.href = pdfUrl;
      window.setTimeout(() => URL.revokeObjectURL(pdfUrl), 120000);
    } catch (reason) {
      windowRef.close();
      setError(reason instanceof Error ? reason.message : tx("The Material Pickup PDF could not be created.", "No se pudo crear el PDF de recogida de materiales."));
    } finally { setPrinting(false); }
  }

  return <div className="breaker-console stolen-breaker-console">
    <header className="breaker-console-header">
      <img src="/crest-electrical-solutions-logo.png" alt="Crest Electrical Solutions" />
      <div><p className="eyebrow">{tx("MATERIALS CONTROL", "CONTROL DE MATERIALES")}</p><h2>{tx("Stolen Breaker", "Breaker Robado")}</h2><p>{tx("Create one Material Pickup document using the outgoing Breaker Swap materials assigned to the selected address.", "Cree un solo documento de recogida usando los materiales de salida de Breaker Swap asociados a la dirección seleccionada.")}</p></div>
      <div className="breaker-header-actions"><button className="button ghost" type="button" onClick={onBack}>{tx("Modules", "Módulos")}</button></div>
    </header>
    <main className="stolen-breaker-content">
      {previewOnly && <p className="breaker-preview-banner">{tx("Local design preview — printing uses sample data only.", "Vista previa local de diseño: la impresión usa datos de ejemplo.")}</p>}
      <section className="breaker-search-card">
        <div className="breaker-search-grid">
          <label><span>{tx("Search jobsite address", "Buscar dirección de trabajo")}</span><input autoFocus value={search} onChange={(event) => { setSearch(event.target.value); if (!previewOnly) setSelected(null); }} placeholder={tx("Start typing an address", "Comience a escribir una dirección")} /></label>
          <label><span>{tx("Work Order (required)", "Orden de trabajo (obligatoria)")}</span><input inputMode="numeric" value={workOrder} onChange={(event) => setWorkOrder(event.target.value.replace(/\D/g, ""))} placeholder={tx("Numbers only", "Solo números")} /></label>
          <label><span>{tx("Supervisor name (required)", "Nombre del supervisor (obligatorio)")}</span><input value={supervisor} onChange={(event) => setSupervisor(event.target.value)} placeholder={tx("Supervisor name", "Nombre del supervisor")} /></label>
          <label><span>{tx("Service technician (required)", "Técnico de servicio (obligatorio)")}</span><input value={serviceTechnician} onChange={(event) => setServiceTechnician(event.target.value)} placeholder={tx("Service technician name", "Nombre del técnico de servicio")} /></label>
          <label><span>{tx("Date", "Fecha")}</span><input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
        </div>
        <div className="breaker-results" role="listbox" aria-label={tx("Address results", "Resultados de direcciones")}>
          {results.map((record) => <button key={record.address} type="button" className={selected?.address === record.address ? "selected" : ""} onClick={() => { setSelected(record); setSearch(record.address); }}><span>{record.address}</span><small>{record.outgoing.length} {tx("materials to pick up", "materiales para recoger")}</small></button>)}
          {loading && <p className="breaker-empty">{tx("Loading addresses…", "Cargando direcciones…")}</p>}
          {!loading && !previewOnly && search.trim().length >= 2 && !results.length && !error && <p className="breaker-empty">{tx("No addresses match that search.", "No hay direcciones que coincidan con esa búsqueda.")}</p>}
        </div>
      </section>
      {selected && <section className="stolen-pickup-card">
        <div><p className="eyebrow">{tx("MATERIAL PICKUP", "RECOGIDA DE MATERIALES")}</p><h3>{selected.address}</h3><p>{tx("These are the outgoing materials assigned to this address in Breaker Swap.", "Estos son los materiales de salida asociados a esta dirección en Breaker Swap.")}</p></div>
        <div className="stolen-pickup-lines">{pickupItems.map((item, index) => <div key={`${item.code}-${index}`}><b>{item.quantity}</b><span>{item.description}</span><small>{item.code}</small></div>)}</div>
        <button className="button primary" type="button" disabled={!canPrint} onClick={() => void printPickup()}>{printing ? tx("Preparing PDF…", "Preparando PDF…") : tx("Print Material Pickup", "Imprimir recogida de materiales")}</button>
      </section>}
      <section className="stolen-pickup-history" aria-live="polite">
        <div className="stolen-history-heading">
          <div><p className="eyebrow">{tx("TODAY'S ACTIVITY", "ACTIVIDAD DEL DÍA")}</p><h3>{tx("Saved pickup addresses", "Direcciones guardadas para recogida")}</h3></div>
          <span>{pickupList.length} {tx("saved", "guardadas")}</span>
        </div>
        {pickupList.length ? <div className="stolen-history-list">{pickupList.map((entry) => <article key={`${entry.address}-${entry.workOrder}-${entry.date}`}>
          <div><strong>{entry.address}</strong><small>{tx("WO", "OT")} {entry.workOrder} · {entry.date}</small></div>
          <div><span>{tx("Supervisor", "Supervisor")}</span><b>{entry.supervisor}</b></div>
          <div><span>{tx("Technician", "Técnico")}</span><b>{entry.serviceTechnician}</b></div>
          <div className="stolen-history-count"><b>{entry.unitCount}</b><small>{tx("units · ", "unidades · ")}{entry.itemCount} {tx("materials", "materiales")}</small></div>
        </article>)}</div> : <p className="stolen-history-empty">{tx("Completed Material Pickup documents will be listed here during this session.", "Las recogidas de materiales completadas aparecerán aquí durante esta sesión.")}</p>}
      </section>
      {error && <p className="breaker-error" role="alert">{error}</p>}
      {saved && <p className="breaker-success" role="status">{saved}</p>}
    </main>
  </div>;
}
