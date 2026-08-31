"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import type { AppLanguage } from "./language-switcher";

type Props = { onBack: () => void; language: AppLanguage };
type MaterialLine = { description: string; code: string; quantity: number; sourceMaterial?: string };
type AddressRecord = { address: string; status: string; outgoing: MaterialLine[]; returns: MaterialLine[] };
type SwapEntry = AddressRecord & { id: string; date: string; supervisor: string; workOrder: string; recorded: boolean };
type Movement = {
  id: string;
  entryId: string;
  kind: "outgoing" | "return";
  status: "posted" | "pending" | "confirmed";
  date: string;
  address: string;
  supervisor?: string;
  workOrder: string;
  items: MaterialLine[];
  createdAt: string;
  confirmedAt?: string;
};
type PdfSource = Pick<SwapEntry, "id" | "date" | "address" | "supervisor" | "workOrder" | "outgoing" | "returns">;

function localDate() {
  const date = new Date();
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function uniqueId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function validMaterialLine(value: unknown): value is MaterialLine {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<MaterialLine>;
  return typeof item.description === "string" && typeof item.code === "string" && typeof item.quantity === "number" && Number.isFinite(item.quantity) && item.quantity > 0;
}

function validAddressRecord(value: unknown): value is AddressRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<AddressRecord>;
  return typeof record.address === "string" && typeof record.status === "string" && Array.isArray(record.outgoing) && record.outgoing.every(validMaterialLine) && Array.isArray(record.returns) && record.returns.every(validMaterialLine);
}

function validMovement(value: unknown): value is Movement {
  if (!value || typeof value !== "object") return false;
  const movement = value as Partial<Movement>;
  return typeof movement.id === "string" && typeof movement.entryId === "string" && (movement.kind === "outgoing" || movement.kind === "return") && (movement.status === "posted" || movement.status === "pending" || movement.status === "confirmed") && typeof movement.address === "string" && (movement.supervisor === undefined || typeof movement.supervisor === "string") && typeof movement.workOrder === "string" && typeof movement.date === "string" && Array.isArray(movement.items) && movement.items.every(validMaterialLine) && typeof movement.createdAt === "string";
}

function totalUnits(items: MaterialLine[]) {
  return items.reduce((sum, item) => sum + item.quantity, 0);
}

export function BreakerSwapPanel({ onBack, language }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authenticated, setAuthenticated] = useState(false);
  const [authChecking, setAuthChecking] = useState(true);
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [addressRecords, setAddressRecords] = useState<AddressRecord[]>([]);
  const [addressesLoading, setAddressesLoading] = useState(true);
  const [addressesError, setAddressesError] = useState("");
  const [search, setSearch] = useState("");
  const [address, setAddress] = useState("");
  const [supervisor, setSupervisor] = useState("");
  const [workOrder, setWorkOrder] = useState("");
  const [swapDate, setSwapDate] = useState(localDate());
  const [entries, setEntries] = useState<SwapEntry[]>([]);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [ledgerLoading, setLedgerLoading] = useState(true);
  const [ledgerError, setLedgerError] = useState("");
  const [previewingKey, setPreviewingKey] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [printing, setPrinting] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [pendingSearch, setPendingSearch] = useState("");
  const tx = (english: string, spanish: string) => language === "es" ? spanish : english;

  useEffect(() => {
    document.body.classList.add("breaker-swap-active");

    return () => {
      document.body.classList.remove("breaker-swap-active");
    };
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/api/breaker-swap-auth", { cache: "no-store" })
      .then(async (response) => ({ response, data: await response.json().catch(() => null) as { email?: string } | null }))
      .then(({ response, data }) => {
        if (!active || !response.ok) return;
        setAuthenticated(true);
        setEmail(data?.email || "");
      })
      .finally(() => { if (active) setAuthChecking(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    let active = true;
    fetch("/api/breaker-swap?resource=addresses", { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(tx("The central Breaker Swap address list is not available.", "La lista central de direcciones de Breaker Swap no está disponible."));
        return response.json();
      })
      .then((data: unknown) => {
        if (!active) return;
        if (!Array.isArray(data) || !data.every(validAddressRecord)) throw new Error(tx("The central Breaker Swap address list has an invalid format.", "La lista central de direcciones de Breaker Swap tiene un formato inválido."));
        setAddressRecords(data);
        setAddressesError("");
      })
      .catch((error: unknown) => {
        if (!active) return;
        setAddressesError(error instanceof Error ? error.message : tx("Addresses and materials could not be loaded.", "No se pudieron cargar las direcciones y los materiales."));
      })
      .finally(() => {
        if (active) setAddressesLoading(false);
      });
    return () => { active = false; };
  }, [authenticated]);

  useEffect(() => {
    if (!authenticated) return;
    void loadLedger();
  }, [authenticated]);

  async function loadLedger() {
    setLedgerLoading(true);
    try {
      const response = await fetch("/api/breaker-swap?resource=ledger", { cache: "no-store" });
      const data: unknown = await response.json();
      if (!response.ok || !Array.isArray(data) || !data.every(validMovement)) throw new Error(tx("The central movement ledger could not be loaded.", "No se pudo cargar el registro central de movimientos."));
      setMovements(data);
      setLedgerError("");
    } catch (error) {
      setLedgerError(error instanceof Error ? error.message : tx("The central movement ledger could not be loaded.", "No se pudo cargar el registro central de movimientos."));
    } finally {
      setLedgerLoading(false);
    }
  }

  const visibleRecords = useMemo(() => {
    const term = search.trim().toLowerCase();
    return addressRecords.filter((record) => !term || record.address.toLowerCase().includes(term)).slice(0, 150);
  }, [addressRecords, search]);

  const selectedRecord = useMemo(() => addressRecords.find((record) => record.address === address), [addressRecords, address]);
  const pendingReturns = useMemo(() => movements.filter((movement) => movement.kind === "return" && movement.status === "pending"), [movements]);
  const visiblePendingReturns = useMemo(() => {
    const term = pendingSearch.trim().toLocaleLowerCase();
    return pendingReturns.filter((movement) => !term || movement.address.toLocaleLowerCase().includes(term));
  }, [pendingReturns, pendingSearch]);
  const postedOutgoing = useMemo(() => movements.filter((movement) => movement.kind === "outgoing" && movement.status === "posted"), [movements]);
  const confirmedReturns = useMemo(() => movements.filter((movement) => movement.kind === "return" && movement.status === "confirmed"), [movements]);

  async function submitLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoginLoading(true);
    setLoginError("");
    try {
      const response = await fetch("/api/breaker-swap-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const data = await response.json().catch(() => null) as { email?: string; error?: string } | null;
      if (!response.ok) throw new Error(data?.error || tx("The email or password is not valid.", "El correo electrónico o la contraseña no son válidos."));
      setEmail(data?.email || email.trim());
      setAddressesLoading(true);
      setLedgerLoading(true);
      setAuthenticated(true);
      setPassword("");
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : tx("Supabase authentication is not available.", "La autenticación de Supabase no está disponible."));
    } finally {
      setLoginLoading(false);
    }
  }

  async function signOut() {
    await fetch("/api/breaker-swap-auth", { method: "DELETE" }).catch(() => null);
    setAuthenticated(false);
    setPassword("");
    setAddressRecords([]);
    setMovements([]);
    setEntries([]);
    setAddressesLoading(true);
    setLedgerLoading(true);
  }

  function addSwap() {
    if (!selectedRecord || supervisor.trim().length < 2 || !workOrder || !swapDate || (!selectedRecord.outgoing.length && !selectedRecord.returns.length)) return;
    setEntries((current) => [...current, {
      ...selectedRecord,
      id: uniqueId("swap"),
      date: swapDate,
      supervisor: supervisor.trim(),
      workOrder,
      recorded: false,
    }]);
    setAddress("");
    setSearch("");
    setWorkOrder("");
  }

  function removeSwap(id: string) {
    setEntries((current) => current.filter((entry) => entry.id !== id));
  }

  async function printSwap() {
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      setPreviewError(tx("Allow pop-ups for this page to print the Pickup and Return PDFs.", "Permita las ventanas emergentes de esta página para imprimir los PDF de recogida y devolución."));
      return;
    }

    printWindow.document.title = tx("Preparing Breaker Swap PDFs", "Preparando los PDF de Breaker Swap");
    printWindow.document.body.textContent = tx("Preparing Pickup and Return PDFs for printing...", "Preparando los PDF de recogida y devolución para imprimir...");
    setPrinting(true);
    setPreviewError("");

    try {
      const { createBreakerSwapPrintPdf } = await import("./lib/breaker-swap-pdf");
      const documents = entries.flatMap((entry) => ([
        {
          address: entry.address,
          supervisor: entry.supervisor,
          workOrder: entry.workOrder,
          swapDate: entry.date,
          documentType: "outgoing" as const,
          items: entry.outgoing.map((item) => ({
            category: "MATERIAL PICKUP",
            materialCode: item.code,
            itemNumber: "",
            lineNumber: "",
            description: item.description,
            quantity: item.quantity,
          })),
        },
        {
          address: entry.address,
          supervisor: entry.supervisor,
          workOrder: entry.workOrder,
          swapDate: entry.date,
          documentType: "return" as const,
          items: entry.returns.map((item) => ({
            category: "MATERIAL RETURN",
            materialCode: item.code,
            itemNumber: "",
            lineNumber: "",
            description: item.description,
            quantity: item.quantity,
          })),
        },
      ]));
      const pdfBytes = await createBreakerSwapPrintPdf(documents);
      const saveResponse = await fetch("/api/breaker-swap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobs: entries }),
      });
      const saveResult = await saveResponse.json().catch(() => null) as { error?: string } | null;
      if (!saveResponse.ok) throw new Error(saveResult?.error || tx("Breaker Swap could not be registered in Supabase.", "No se pudo registrar el Breaker Swap en Supabase."));

      const pdfUrl = URL.createObjectURL(new Blob([new Uint8Array(pdfBytes)], { type: "application/pdf" }));
      let printStarted = false;
      const startPrint = () => {
        if (printStarted || printWindow.closed) return;
        printStarted = true;
        try {
          printWindow.focus();
          printWindow.print();
        } catch {
          // The combined PDF remains open so the browser's PDF print button can be used.
        }
      };
      printWindow.addEventListener("load", () => window.setTimeout(startPrint, 350), { once: true });
      printWindow.location.href = pdfUrl;
      window.setTimeout(startPrint, 1_500);
      window.setTimeout(() => URL.revokeObjectURL(pdfUrl), 120_000);
      await loadLedger();
      setEntries((current) => current.map((entry) => ({ ...entry, recorded: true })));
    } catch (error) {
      printWindow.close();
      setPreviewError(error instanceof Error ? error.message : tx("The Pickup and Return PDFs could not be prepared for printing.", "No se pudieron preparar los PDF de recogida y devolución para imprimir."));
    } finally {
      setPrinting(false);
    }
  }

  async function confirmReturn(id: string) {
    setConfirmingId(id);
    setLedgerError("");
    try {
      const response = await fetch("/api/breaker-swap", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ movementId: id, confirmedBy: email.trim() || "Office" }),
      });
      const result = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(result?.error || tx("The material return could not be confirmed.", "No se pudo confirmar la devolución de materiales."));
      await loadLedger();
    } catch (error) {
      setLedgerError(error instanceof Error ? error.message : tx("The material return could not be confirmed.", "No se pudo confirmar la devolución de materiales."));
    } finally {
      setConfirmingId(null);
    }
  }

  async function previewPdf(source: PdfSource, kind: "outgoing" | "return") {
    if (!/^\d+$/.test(source.workOrder)) {
      setPreviewError(tx("A numeric Work Order is required before previewing the PDF.", "Se requiere una orden de trabajo numérica antes de ver el PDF."));
      return;
    }
    const items = kind === "outgoing" ? source.outgoing : source.returns;
    if (!items.length) {
      setPreviewError(language === "es" ? `No hay cantidades positivas de materiales de ${kind === "outgoing" ? "recogida" : "devolución"} disponibles para esta dirección.` : `No positive ${kind === "outgoing" ? "pickup" : "return"} material quantities are available for this address.`);
      return;
    }
    const previewWindow = window.open("", "_blank");
    if (!previewWindow) {
      setPreviewError(tx("Allow pop-ups for this page to open the PDF preview.", "Permita las ventanas emergentes de esta página para abrir la vista previa del PDF."));
      return;
    }
    previewWindow.document.title = tx("Preparing Breaker Swap PDF", "Preparando el PDF de Breaker Swap");
    previewWindow.document.body.textContent = tx("Preparing PDF preview...", "Preparando la vista previa del PDF...");
    const previewKey = `${source.id}:${kind}`;
    setPreviewingKey(previewKey);
    setPreviewError("");
    try {
      const { createBreakerSwapPdf } = await import("./lib/breaker-swap-pdf");
      const pdfBytes = await createBreakerSwapPdf({
        address: source.address,
        supervisor: source.supervisor,
        workOrder: source.workOrder,
        swapDate: source.date,
        documentType: kind,
        items: items.map((item) => ({
          category: kind === "outgoing" ? "MATERIAL PICKUP" : "MATERIAL RETURN",
          materialCode: item.code,
          itemNumber: "",
          lineNumber: "",
          description: item.description,
          quantity: item.quantity,
        })),
      });
      const pdfUrl = URL.createObjectURL(new Blob([new Uint8Array(pdfBytes)], { type: "application/pdf" }));
      previewWindow.location.href = pdfUrl;
      window.setTimeout(() => URL.revokeObjectURL(pdfUrl), 60_000);
    } catch (error) {
      previewWindow.close();
      setPreviewError(error instanceof Error ? error.message : tx("The PDF preview could not be created.", "No se pudo crear la vista previa del PDF."));
    } finally {
      setPreviewingKey(null);
    }
  }

  function showPendingReturns() {
    document.getElementById("breaker-pending-title")?.closest("section")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const canAdd = Boolean(selectedRecord && supervisor.trim().length >= 2 && /^\d+$/.test(workOrder) && swapDate && (selectedRecord.outgoing.length || selectedRecord.returns.length));
  const canPrint = !printing && entries.length > 0 && entries.every((entry) => entry.supervisor.trim().length >= 2 && /^\d+$/.test(entry.workOrder));

  if (authChecking) {
    return <div className="breaker-login-card"><img src="/crest-electrical-solutions-logo.png" alt="Crest Electrical Solutions" /><p className="eyebrow">{tx("SECURE ACCESS", "ACCESO SEGURO")}</p><h2 id="start-title">Breaker Swap</h2><p className="modal-copy">{tx("Checking your Supabase session…", "Verificando su sesión de Supabase…")}</p></div>;
  }

  if (!authenticated) {
    return <div className="breaker-login-card">
      <img src="/crest-electrical-solutions-logo.png" alt="Crest Electrical Solutions" />
      <p className="eyebrow">{tx("SUPABASE SECURE ACCESS", "ACCESO SEGURO DE SUPABASE")}</p>
      <h2 id="start-title">Breaker Swap</h2>
      <p className="modal-copy">{tx("Sign in with an authorized Breaker Swap account.", "Inicie sesión con una cuenta autorizada de Breaker Swap.")}</p>
      <form className="breaker-login" onSubmit={submitLogin}>
        <label><span>{tx("Email", "Correo electrónico")}</span><input autoFocus type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <label><span>{tx("Password", "Contraseña")}</span><input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        {loginError && <p className="breaker-error" role="alert">{loginError}</p>}
        <div className="modal-actions">
          <button className="button ghost" type="button" onClick={onBack}>{tx("Back", "Regresar")}</button>
          <button className="button primary" type="submit" disabled={loginLoading}>{loginLoading ? tx("Signing in…", "Iniciando sesión…") : tx("Enter Breaker Swap", "Entrar a Breaker Swap")}</button>
        </div>
      </form>
      <p className="breaker-local-note">{tx("Authentication is validated by Supabase.", "La autenticación es validada por Supabase.")}</p>
    </div>;
  }

  return <div className="breaker-console">
    <header className="breaker-console-header">
      <img src="/crest-electrical-solutions-logo.png" alt="Crest Electrical Solutions" />
      <div><p className="eyebrow">{tx("MATERIALS CONTROL", "CONTROL DE MATERIALES")}</p><h2 id="start-title">Breaker Swap</h2><p>{tx("Pickup materials post immediately when printed; returns stay pending until confirmed.", "Los materiales de recogida se contabilizan al imprimir; las devoluciones quedan pendientes hasta ser confirmadas.")}</p></div>
      <div className="breaker-header-actions"><button className="button ghost" type="button" onClick={onBack}>{tx("Back", "Regresar")}</button><button className="button ghost" type="button" onClick={() => void signOut()}>{tx("Sign out", "Cerrar sesión")}</button></div>
    </header>

    <div className="breaker-ledger-summary" aria-label={tx("Central inventory movement summary", "Resumen central de movimientos de inventario")} aria-busy={ledgerLoading}>
      <div className="breaker-ledger-card"><span>{tx("Pickup posted", "Recogidas registradas")}</span><strong>{postedOutgoing.length}</strong><small>{postedOutgoing.reduce((sum, movement) => sum + totalUnits(movement.items), 0)} {tx("units out", "unidades entregadas")}</small></div>
      <button className="breaker-ledger-card breaker-ledger-link" type="button" onClick={showPendingReturns} title={tx("View pending return addresses", "Ver direcciones con devoluciones pendientes")}><span>{tx("Pending returns", "Devoluciones pendientes")}</span><strong>{pendingReturns.length}</strong><small>{pendingReturns.reduce((sum, movement) => sum + totalUnits(movement.items), 0)} {tx("units waiting · View addresses", "unidades pendientes · Ver direcciones")}</small></button>
      <div className="breaker-ledger-card"><span>{tx("Returns confirmed", "Devoluciones confirmadas")}</span><strong>{confirmedReturns.length}</strong><small>{confirmedReturns.reduce((sum, movement) => sum + totalUnits(movement.items), 0)} {tx("units in", "unidades recibidas")}</small></div>
      <p>{ledgerLoading ? tx("Loading Supabase ledger…", "Cargando registro de Supabase…") : tx("Supabase central ledger", "Registro central de Supabase")}</p>
    </div>
    {ledgerError && <p className="breaker-error" role="alert">{ledgerError}</p>}

    <div className="breaker-toolbar">
      <label><span>{tx("Date", "Fecha")}</span><input type="date" value={swapDate} onInput={(event) => setSwapDate(event.currentTarget.value)} onChange={(event) => setSwapDate(event.target.value)} /></label>
      <label className="breaker-search"><span>{tx("Search jobsite address", "Buscar dirección del trabajo")}</span><input type="search" value={search} onChange={(event) => { setSearch(event.target.value); setAddress(""); }} placeholder={tx("Start typing an address", "Comience a escribir una dirección")} /></label>
      <label><span>{tx("Work Order (required)", "Orden de trabajo (obligatoria)")}</span><input required aria-required="true" inputMode="numeric" pattern="[0-9]*" value={workOrder} onChange={(event) => setWorkOrder(event.target.value.replace(/\D/g, ""))} placeholder={tx("Required - numbers only", "Obligatoria - solo números")} /></label>
      <label><span>{tx("Supervisor name (required)", "Nombre del supervisor (obligatorio)")}</span><input required aria-required="true" value={supervisor} onChange={(event) => setSupervisor(event.target.value)} placeholder={tx("Supervisor name", "Nombre del supervisor")} /></label>
    </div>
    <div className="breaker-results" role="listbox" aria-label={tx("Address results", "Resultados de direcciones")} aria-busy={addressesLoading}>
      {!addressesLoading && !addressesError && visibleRecords.map((record) => <button className={address === record.address ? "selected" : ""} type="button" role="option" aria-selected={address === record.address} key={record.address} onClick={() => { setAddress(record.address); setSearch(record.address); }}>
        <span>{record.address}</span><small className={`breaker-source-status status-${record.status.toLowerCase()}`}>{record.status || tx("UNKNOWN", "DESCONOCIDO")} · {record.outgoing.length} {tx("pickup", "recogida")} · {record.returns.length} {tx("return", "devolución")}</small>
      </button>)}
      {addressesLoading && <p className="breaker-empty">{tx("Loading addresses and materials from Supabase…", "Cargando direcciones y materiales desde Supabase…")}</p>}
      {addressesError && <p className="breaker-error" role="alert">{addressesError}</p>}
      {!addressesLoading && !addressesError && !visibleRecords.length && <p className="breaker-empty">{tx("No addresses match that search.", "No hay direcciones que coincidan con esa búsqueda.")}</p>}
    </div>
    <div className="breaker-actions">
      <span>{selectedRecord ? (language === "es" ? `Seleccionada: ${selectedRecord.address} · ${selectedRecord.outgoing.length} líneas de recogida · ${selectedRecord.returns.length} líneas de devolución${selectedRecord.status !== "OK" ? ` · Estado de origen ${selectedRecord.status}` : ""}` : `Selected: ${selectedRecord.address} · ${selectedRecord.outgoing.length} pickup lines · ${selectedRecord.returns.length} return lines${selectedRecord.status !== "OK" ? ` · Source status ${selectedRecord.status}` : ""}`) : tx(`Select an address from ${addressRecords.length} central results.`, `Seleccione una dirección entre ${addressRecords.length} resultados centrales.`)}</span>
      <button className="button secondary breaker-add" type="button" disabled={!canAdd} onClick={addSwap}>+ {tx("Add to list", "Agregar a la lista")}</button>
    </div>

    <section className="breaker-queue" aria-labelledby="breaker-queue-title">
      <div className="breaker-queue-heading">
        <div><p className="eyebrow">{tx("PRINT LIST", "LISTA DE IMPRESIÓN")}</p><h3 id="breaker-queue-title">{tx("Breaker Swap Jobs", "Trabajos de Breaker Swap")}</h3></div>
        <span>{entries.length} {language === "es" ? (entries.length === 1 ? "trabajo" : "trabajos") : (entries.length === 1 ? "job" : "jobs")}</span>
      </div>
      {!entries.length ? <div className="breaker-queue-empty"><strong>{tx("No jobs added yet", "Todavía no hay trabajos agregados")}</strong><span>{tx("Select an address, enter its Work Order, then add it to this list.", "Seleccione una dirección, ingrese su orden de trabajo y agréguela a esta lista.")}</span></div> : <div className="breaker-table" role="table" aria-label={tx("Breaker swap jobs", "Trabajos de Breaker Swap")}>
        <div className="breaker-table-head" role="row"><span>{tx("Date", "Fecha")}</span><span>{tx("Address and materials", "Dirección y materiales")}</span><span>{tx("Work Order", "Orden de trabajo")}</span><span>{tx("PDF previews", "Vistas previas PDF")}</span></div>
        {entries.map((entry) => <article className="breaker-table-row" role="row" key={entry.id}>
          <span>{entry.date}{entry.recorded && <small className="breaker-posted-badge">{tx("Posted", "Registrado")}</small>}</span>
          <strong>{entry.address}<small>{tx("Supervisor", "Supervisor")}: {entry.supervisor} · {entry.outgoing.length} {tx("pickup lines", "líneas de recogida")} · {entry.returns.length} {tx("return lines", "líneas de devolución")}</small></strong>
          <span>WO {entry.workOrder}</span>
          <span className="breaker-row-actions">
            <button className="breaker-preview" type="button" disabled={previewingKey === `${entry.id}:outgoing`} onClick={() => void previewPdf(entry, "outgoing")}>{previewingKey === `${entry.id}:outgoing` ? tx("Preparing…", "Preparando…") : tx("Pickup PDF", "PDF de recogida")}</button>
            <button className="breaker-preview breaker-return-preview" type="button" disabled={previewingKey === `${entry.id}:return`} onClick={() => void previewPdf(entry, "return")}>{previewingKey === `${entry.id}:return` ? tx("Preparing…", "Preparando…") : tx("Return PDF", "PDF de devolución")}</button>
            <button type="button" onClick={() => removeSwap(entry.id)} aria-label={tx(`Remove ${entry.address} from print list`, `Eliminar ${entry.address} de la lista de impresión`)}>{tx("Remove", "Eliminar")}</button>
          </span>
        </article>)}
      </div>}
      {previewError && <p className="breaker-error breaker-preview-error" role="alert">{previewError}</p>}
      <div className="breaker-print-actions"><span>{tx("Printing opens one combined PDF with a Pickup page and a Return page for every address.", "La impresión abre un PDF combinado con una página de recogida y otra de devolución para cada dirección.")}</span><button className="button primary" type="button" disabled={!canPrint} onClick={() => void printSwap()}>{printing ? tx("Preparing PDFs...", "Preparando PDF...") : tx("Print Breaker Swap", "Imprimir Breaker Swap")}</button></div>
    </section>

    <section className="breaker-queue breaker-pending" aria-labelledby="breaker-pending-title">
      <div className="breaker-queue-heading">
        <div><p className="eyebrow">{tx("OFFICE CONFIRMATION", "CONFIRMACIÓN DE OFICINA")}</p><h3 id="breaker-pending-title">{tx("Pending Material Returns", "Devoluciones de materiales pendientes")}</h3></div>
        <span>{pendingReturns.length} {tx("pending", "pendientes")}</span>
      </div>
      <div className="breaker-pending-search" role="search">
        <label htmlFor="pending-return-search"><span>{tx("Search pending address", "Buscar dirección pendiente")}</span><input id="pending-return-search" type="search" value={pendingSearch} onChange={(event) => setPendingSearch(event.target.value)} placeholder={tx("Type an address to filter this list", "Escriba una dirección para filtrar esta lista")} /></label>
        <small>{pendingSearch.trim() ? tx(`${visiblePendingReturns.length} of ${pendingReturns.length} pending`, `${visiblePendingReturns.length} de ${pendingReturns.length} pendientes`) : tx(`${pendingReturns.length} pending addresses`, `${pendingReturns.length} direcciones pendientes`)}</small>
      </div>
      {!pendingReturns.length ? <div className="breaker-queue-empty"><strong>{tx("No material returns are pending", "No hay devoluciones de materiales pendientes")}</strong><span>{tx("They will appear here after Print Breaker Swap is used.", "Aparecerán aquí después de usar Imprimir Breaker Swap.")}</span></div> : !visiblePendingReturns.length ? <div className="breaker-queue-empty"><strong>{tx("No pending addresses match this search", "No hay direcciones pendientes que coincidan con esta búsqueda")}</strong><span>{tx("Try another part of the address.", "Intente con otra parte de la dirección.")}</span></div> : <div className="breaker-pending-list">
        {visiblePendingReturns.map((movement) => <article className="breaker-pending-row" key={movement.id}>
          <div><strong>{movement.address}</strong><span>{movement.date} · WO {movement.workOrder} · {tx("Supervisor", "Supervisor")}: {movement.supervisor || tx("Not recorded", "No registrado")}</span></div>
          <div className="breaker-pending-materials">{movement.items.map((item, index) => <span key={`${item.code}-${index}`}><b>{item.quantity}</b> {item.description} <small>{item.code}</small></span>)}</div>
          <div className="breaker-pending-actions">
            <button className="breaker-preview" type="button" onClick={() => void previewPdf({ id: movement.id, date: movement.date, address: movement.address, supervisor: movement.supervisor || tx("Not recorded", "No registrado"), workOrder: movement.workOrder, outgoing: [], returns: movement.items }, "return")}>{tx("Return PDF", "PDF de devolución")}</button>
            <button className="button primary" type="button" disabled={confirmingId === movement.id} onClick={() => void confirmReturn(movement.id)}>{confirmingId === movement.id ? tx("Confirming…", "Confirmando…") : tx("Confirm Material Return", "Confirmar devolución de materiales")}</button>
          </div>
        </article>)}
      </div>}
    </section>

    <section className="breaker-print-sheet" aria-hidden="true">
      <div className="breaker-print-header"><img src="/crest-electrical-solutions-logo.png" alt="" /><div><h1>BREAKER SWAP</h1><p>{entries.length} {entries.length === 1 ? "job" : "jobs"}</p></div></div>
      <table><thead><tr><th>Date</th><th>Address</th><th>Supervisor</th><th>Work Order</th></tr></thead><tbody>{entries.map((entry) => <tr key={entry.id}><td>{entry.date}</td><td>{entry.address}</td><td>{entry.supervisor}</td><td>{entry.workOrder}</td></tr>)}</tbody></table>
    </section>
  </div>;
}
