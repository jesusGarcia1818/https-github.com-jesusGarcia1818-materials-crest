"use client";

import { useEffect, useMemo, useState } from "react";
import { BreakerSwapPanel } from "./breaker-swap-panel";
import { AppLanguage, LanguageSwitcher } from "./language-switcher";
import materialCatalog from "./materials-catalog.json";

type QuantityMap = Record<string, string>;
type MaterialTransactionType = "request" | "return";
type Department = "technical_service" | "subcontractor";
type Item = { key: string; sourceRow: number; groupIndex: number; legacyCode: string; code: string; itemNumber: string; line: string; description: string; category: string; groupedCategory: string; excelRow: number };
type SavedRequest = { code: string; name: string; address: string; department?: Department; workOrder?: string; requestDate?: string; quantities: QuantityMap; version: number; type?: MaterialTransactionType };
type RequestItemPayload = {
  material_key: string;
  source_row: number;
  group_index: number;
  legacy_code: string;
  material_code: string;
  item_number: string;
  line_number: string;
  description: string;
  category: string;
  quantity: number;
};
type CartRequest = {
  type: MaterialTransactionType;
  code: string;
  name: string;
  address: string;
  department: Department;
  workOrder: string;
  requestDate: string;
  version: number;
  items: RequestItemPayload[];
};

const cartStorageKey = "crest-material-request-cart-v1";
const languageStorageKey = "crest-language-v1";

function normalizeCartRequest(entry: unknown): CartRequest | null {
  if (!entry || typeof entry !== "object") return null;
  const candidate = entry as Partial<CartRequest>;
  const workOrder = String(candidate.workOrder || "").replace(/\D/g, "");
  const department: Department = candidate.department === "subcontractor"
    ? "subcontractor"
    : candidate.department === "technical_service"
      ? "technical_service"
      : workOrder
        ? "technical_service"
        : "subcontractor";
  if (!candidate.code || !candidate.name || !candidate.address || !candidate.requestDate || !Array.isArray(candidate.items)) return null;
  return {
    type: candidate.type === "return" ? "return" : "request",
    code: String(candidate.code),
    name: String(candidate.name),
    address: String(candidate.address),
    department,
    workOrder,
    requestDate: String(candidate.requestDate),
    version: Number.isInteger(candidate.version) && Number(candidate.version) > 0 ? Number(candidate.version) : 1,
    items: candidate.items,
  };
}

function localDate() {
  const date = new Date();
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function showDate(value: string) {
  if (!value) return "";
  const [year, month, day] = value.slice(0, 10).split("-");
  return `${month}/${day}/${year}`;
}
const items = materialCatalog as Item[];
const categories = Array.from(new Set(items.map((item) => item.groupedCategory)));
const spanishCategoryNames: Record<string, string> = {
  "Copper Wire": "Cable de cobre",
  "Copperclad Wire": "Cable copper clad",
  "Eaton": "Eaton",
  "Electrical Boxes": "Cajas eléctricas",
  "Lighting": "Iluminación",
  "Miscellaneous Wire": "Cables varios",
  "Others": "Otros",
  "PVC & PVC Parts": "PVC y piezas de PVC",
  "SQD": "Square D",
  "OTHER MATERIALS": "OTROS MATERIALES",
  "BOXES AND BARS": "CAJAS Y BARRAS",
  "HARDWARE AND ACCESSORIES": "HERRAJES Y ACCESORIOS",
  "ELECTRICAL CONNECTORS AND ACCESSORIES": "CONECTORES ELÉCTRICOS Y ACCESORIOS",
  "LIGHTING FIXTURE & ACCESSORIES": "LUMINARIAS Y ACCESORIOS",
  "CANS AND TRIMS": "CANS Y TRIMS",
  "CONDUIT, CONNECTORS, AND ACESSORIES": "TUBERÍA, CONECTORES Y ACCESORIOS",
  "OTHER TRIM ACCESSORIES": "OTROS ACCESORIOS DE TRIM",
  "SMART SWITCHES, SENSORS, AND ACCESSORIES": "INTERRUPTORES INTELIGENTES, SENSORES Y ACCESORIOS",
  "DISCONNECTS": "DESCONECTADORES",
  "COPPER WIRE": "CABLE DE COBRE",
  "TV/PHONE/ETHERNET PLATES AND ACCESSORIES": "PLACAS Y ACCESORIOS DE TV/TELÉFONO/ETHERNET",
  "OTHER WIRE": "OTROS CABLES",
  "PANELS, OTHER BOXES, AND ACCESSORIES": "PANELES, OTRAS CAJAS Y ACCESORIOS",
  "COPPER CLAD WIRE": "CABLE COPPER CLAD",
};

export function MaterialRequestForm() {
  const [language, setLanguage] = useState<AppLanguage>("en");
  const [transactionType, setTransactionType] = useState<MaterialTransactionType>("request");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [department, setDepartment] = useState<Department>("technical_service");
  const [workOrder, setWorkOrder] = useState("");
  const [requestDate, setRequestDate] = useState(localDate());
  const [quantities, setQuantities] = useState<QuantityMap>({});
  const [version, setVersion] = useState(1);
  const [lookupCode, setLookupCode] = useState("");
  const [deleteCode, setDeleteCode] = useState("");
  const [notice, setNotice] = useState("Complete the information to begin.");
  const [modalOpen, setModalOpen] = useState(true);
  const [lookupMode, setLookupMode] = useState(false);
  const [deleteMode, setDeleteMode] = useState(false);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("ALL");
  const [saving, setSaving] = useState(false);
  const [cart, setCart] = useState<CartRequest[]>([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [portalOption, setPortalOption] = useState<"request" | "breaker-swap" | null>(null);
  const tx = (english: string, spanish: string) => language === "es" ? spanish : english;
  const isReturn = transactionType === "return";
  const transactionCopy = (requestEnglish: string, returnEnglish: string, requestSpanish: string, returnSpanish: string) => language === "es"
    ? (isReturn ? returnSpanish : requestSpanish)
    : (isReturn ? returnEnglish : requestEnglish);

  useEffect(() => {
    const savedLanguage = window.localStorage.getItem(languageStorageKey);
    if (savedLanguage === "en" || savedLanguage === "es") setLanguage(savedLanguage);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(languageStorageKey, language);
    document.documentElement.lang = language;
    setNotice(transactionCopy("Complete the information to begin.", "Complete the return information to begin.", "Complete la información para comenzar.", "Complete la información de la devolución para comenzar."));
  }, [language, transactionType]);

  useEffect(() => {
    try {
      const stored = window.sessionStorage.getItem(cartStorageKey);
      if (stored) {
        const parsed = JSON.parse(stored) as unknown;
        if (Array.isArray(parsed)) setCart(parsed.map(normalizeCartRequest).filter((entry): entry is CartRequest => entry !== null));
      }
    } catch {
      window.sessionStorage.removeItem(cartStorageKey);
    }
  }, []);

  useEffect(() => {
    if (cart.length) window.sessionStorage.setItem(cartStorageKey, JSON.stringify(cart));
    else window.sessionStorage.removeItem(cartStorageKey);
  }, [cart]);

  const selected = useMemo(() => items.filter((item) => Number(quantities[item.key]) > 0), [quantities]);
  const totalUnits = useMemo(() => selected.reduce((sum, item) => sum + Number(quantities[item.key]), 0), [selected, quantities]);
  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return items.filter((item) => (category === "ALL" || item.groupedCategory === category) &&
      (!term || `${item.code} ${item.itemNumber} ${item.line} ${item.description} ${item.legacyCode} ${item.category} ${item.groupedCategory}`.toLowerCase().includes(term)));
  }, [search, category]);
  const group = (list: Item[]) => categories.map((groupName) => ({ name: groupName, rows: list.filter((item) => item.groupedCategory === groupName) })).filter((entry) => entry.rows.length);

  function valid() {
    const normalizedWorkOrder = workOrder.trim();
    const workOrderIsValid = department === "technical_service" ? /^\d+$/.test(normalizedWorkOrder) : normalizedWorkOrder === "" || /^\d+$/.test(normalizedWorkOrder);
    if (address.trim().length < 2 || !workOrderIsValid || name.trim().length < 2) {
      setNotice(department === "technical_service"
        ? tx("Complete Address, a numeric Work Order, and Name before starting.", "Complete la dirección, una orden de trabajo numérica y el nombre antes de comenzar.")
        : tx("Complete Address and Name. Work Order is optional for Subcontractor, but must contain only numbers when provided.", "Complete la dirección y el nombre. La orden de trabajo es opcional para Subcontratista, pero debe contener solo números cuando se ingrese."));
      return false;
    }
    return true;
  }
  async function allocateCode() {
    const response = await fetch("/api/material-requests?allocate=1", { cache: "no-store" });
    const payload = await response.json() as { code?: string; error?: string };
    if (!response.ok || !payload.code) throw new Error(payload.error || transactionCopy("A request number could not be generated.", "A return number could not be generated.", "No se pudo generar un número de solicitud.", "No se pudo generar un número de devolución."));
    return payload.code;
  }
  async function start() {
    if (!valid()) return;
    setSaving(true); setNotice(transactionCopy("Generating a unique request number...", "Generating a unique return number...", "Generando un número de solicitud único...", "Generando un número de devolución único..."));
    try {
      const requestCode = await allocateCode();
      setCode(requestCode);
      setModalOpen(false);
      setNotice(transactionCopy(`Request ${requestCode} is ready for material selection.`, `Return ${requestCode} is ready for material selection.`, `La solicitud ${requestCode} está lista para seleccionar materiales.`, `La devolución ${requestCode} está lista para seleccionar materiales.`));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : transactionCopy("A request number could not be generated.", "A return number could not be generated.", "No se pudo generar un número de solicitud.", "No se pudo generar un número de devolución."));
    } finally { setSaving(false); }
  }
  function reset(preservedName = "") {
    setCode(""); setName(preservedName); setAddress(""); setDepartment("technical_service"); setWorkOrder(""); setRequestDate(localDate());
    setQuantities({}); setVersion(1); setSearch(""); setCategory("ALL"); setLookupCode(""); setDeleteCode("");
    setLookupMode(false); setDeleteMode(false); setModalOpen(true); setNotice(transactionCopy("Complete the information to begin.", "Complete the return information to begin.", "Complete la información para comenzar.", "Complete la información de la devolución para comenzar."));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function quantity(key: string, value: string) {
    if (value === "" || /^\d+$/.test(value)) setQuantities((old) => ({ ...old, [key]: value }));
  }

  function currentRequest(requireItems = true): CartRequest | null {
    if (!valid()) return null;
    if (!/^(?:\d{4}|MAT-[0-9]{8}-[A-Z0-9]{4,12})$/.test(code)) { setNotice(transactionCopy("The request number is not ready. Start the request again.", "The return number is not ready. Start the return again.", "El número de solicitud no está listo. Inicie la solicitud nuevamente.", "El número de devolución no está listo. Inicie la devolución nuevamente.")); return null; }
    if (requireItems && !selected.length) { setNotice(tx("Select at least one material before printing.", "Seleccione al menos un material antes de imprimir.")); return null; }
    const requestItems: RequestItemPayload[] = selected.map((item) => ({
      material_key: item.key, source_row: item.sourceRow, group_index: item.groupIndex,
      legacy_code: item.legacyCode, material_code: item.code, item_number: item.itemNumber, line_number: item.line,
      description: item.description, category: item.groupedCategory, quantity: Number(quantities[item.key]),
    }));
    return { type: transactionType, code, name: name.trim(), address: address.trim(), department, workOrder: workOrder.trim(), requestDate, version, items: requestItems };
  }

  async function submitRequest(request: CartRequest, status: "draft" | "printed") {
    const normalized = normalizeCartRequest(request);
    if (!normalized) throw new Error(tx("This transaction is incomplete. Open it again and verify its information.", "Esta transacción está incompleta. Ábrala nuevamente y verifique su información."));
    const validWorkOrder = normalized.department === "technical_service"
      ? /^\d+$/.test(normalized.workOrder)
      : normalized.workOrder === "" || /^\d+$/.test(normalized.workOrder);
    if (!validWorkOrder) {
      throw new Error(normalized.department === "technical_service"
        ? tx("Technical Service requests require a numeric Work Order.", "Las solicitudes de Servicio Técnico requieren una orden de trabajo numérica.")
        : tx("The optional Subcontractor Work Order must contain only numbers.", "La orden de trabajo opcional de Subcontratista debe contener solo números."));
    }
    const response = await fetch("/api/material-requests", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...normalized, type: normalized.type, status }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || transactionCopy("The request could not be saved.", "The return could not be saved.", "No se pudo guardar la solicitud.", "No se pudo guardar la devolución."));
  }

  async function save(status: "draft" | "printed" = "draft") {
    const request = currentRequest(status === "printed");
    if (!request) return false;
    setSaving(true); setNotice(status === "printed" ? transactionCopy("Creating PDF and sending request by email...", "Creating PDF and sending return by email...", "Creando el PDF y enviando la solicitud por correo...", "Creando el PDF y enviando la devolución por correo...") : transactionCopy("Saving request...", "Saving return...", "Guardando solicitud...", "Guardando devolución..."));
    try {
      await submitRequest(request, status);
      setNotice(status === "printed" ? transactionCopy("Request sent successfully to materials@dfwcrest.com.", "Return sent successfully to materials@dfwcrest.com.", "Solicitud enviada correctamente a materials@dfwcrest.com.", "Devolución enviada correctamente a materials@dfwcrest.com.") : tx("Draft saved successfully.", "Borrador guardado correctamente."));
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : transactionCopy("The request could not be saved.", "The return could not be saved.", "No se pudo guardar la solicitud.", "No se pudo guardar la devolución."));
      return false;
    } finally { setSaving(false); }
  }

  async function openRequest() {
    const normalized = lookupCode.trim().toUpperCase();
    if (!normalized) { setNotice(transactionCopy("Enter the request code.", "Enter the return code.", "Ingrese el código de la solicitud.", "Ingrese el código de la devolución.")); return; }
    setSaving(true); setNotice(transactionCopy("Opening request...", "Opening return...", "Abriendo solicitud...", "Abriendo devolución..."));
    try {
      const response = await fetch(`/api/material-requests?code=${encodeURIComponent(normalized)}`, { cache: "no-store" });
      const record = await response.json() as SavedRequest & { error?: string };
      if (!response.ok) throw new Error(record.error || transactionCopy("Request not found.", "Return not found.", "Solicitud no encontrada.", "Devolución no encontrada."));
      setCode(record.code); setName(record.name); setAddress(record.address);
      setTransactionType(record.type === "return" ? "return" : "request");
      setDepartment(record.department === "subcontractor" ? "subcontractor" : "technical_service");
      setWorkOrder(record.workOrder || ""); setRequestDate(record.requestDate?.slice(0, 10) || localDate());
      setQuantities(record.quantities || {}); setVersion(record.version + 1);
      setModalOpen(false); setLookupMode(false);
      const openedAsReturn = record.type === "return";
      setNotice(language === "es" ? `${openedAsReturn ? "Devolución" : "Solicitud"} ${record.code} abierta - versión ${record.version + 1}.` : `${openedAsReturn ? "Return" : "Request"} ${record.code} opened - version ${record.version + 1}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : transactionCopy("The request could not be opened.", "The return could not be opened.", "No se pudo abrir la solicitud.", "No se pudo abrir la devolución."));
    } finally { setSaving(false); }
  }
  async function deleteRequest() {
    const normalized = deleteCode.trim().toUpperCase();
    if (!normalized) { setNotice(transactionCopy("Enter the request code to delete.", "Enter the return code to delete.", "Ingrese el código de la solicitud que desea eliminar.", "Ingrese el código de la devolución que desea eliminar.")); return; }
    setSaving(true); setNotice(transactionCopy("Deleting request...", "Deleting return...", "Eliminando solicitud...", "Eliminando devolución..."));
    try {
      const response = await fetch(`/api/material-requests?code=${encodeURIComponent(normalized)}`, { method: "DELETE" });
      const payload = await response.json() as { code?: string; error?: string };
      if (!response.ok) throw new Error(payload.error || transactionCopy("The request could not be deleted.", "The return could not be deleted.", "No se pudo eliminar la solicitud.", "No se pudo eliminar la devolución."));
      setCart((old) => old.filter((entry) => entry.code !== normalized));
      reset();
      setNotice(transactionCopy(`Request ${normalized} was deleted from the database.`, `Return ${normalized} was deleted from the database.`, `La solicitud ${normalized} fue eliminada de la base de datos.`, `La devolución ${normalized} fue eliminada de la base de datos.`));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : transactionCopy("The request could not be deleted.", "The return could not be deleted.", "No se pudo eliminar la solicitud.", "No se pudo eliminar la devolución."));
    } finally { setSaving(false); }
  }
  function reviewPrint() {
    if (!currentRequest()) return;
    setCheckoutOpen(true);
  }

  function addAnotherRequest() {
    const request = currentRequest();
    if (!request) return;
    setCart((old) => [...old.filter((entry) => entry.code !== request.code), request]);
    setCheckoutOpen(false);
    reset(request.name);
    setNotice(language === "es" ? `${request.code} fue agregada al carrito como ${request.type === "return" ? "devolución" : "solicitud"}. Ingrese la información del próximo trabajo.` : `${request.code} was added to the cart as a ${request.type}. Enter the next job information.`);
  }

  async function sendRequests(requests: CartRequest[]) {
    if (!requests.length) return;
    setSaving(true);
    setCheckoutOpen(false);
    setCartOpen(false);
    try {
      for (let index = 0; index < requests.length; index += 1) {
        setNotice(tx(`Sending transaction ${index + 1} of ${requests.length}...`, `Enviando transacción ${index + 1} de ${requests.length}...`));
        await submitRequest(requests[index], "printed");
      }
      setCart([]);
      reset();
      setNotice(language === "es" ? `${requests.length} transacción${requests.length === 1 ? "" : "es"} enviada${requests.length === 1 ? "" : "s"} correctamente a materials@dfwcrest.com. El carrito está vacío.` : `${requests.length} transaction${requests.length === 1 ? "" : "s"} sent successfully to materials@dfwcrest.com. Cart is empty.`);
    } catch (error) {
      setNotice(error instanceof Error ? `${error.message} ${tx("The cart was kept so you can try again.", "El carrito se conservó para que pueda intentarlo nuevamente.")}` : tx("The requests could not be sent. The cart was kept.", "No se pudieron enviar las solicitudes. El carrito se conservó."));
    } finally {
      setSaving(false);
    }
  }

  function sendCurrentAndCart() {
    const request = currentRequest();
    if (!request) return;
    const requests = [...cart.filter((entry) => entry.code !== request.code), request];
    void sendRequests(requests);
  }

  function removeFromCart(requestCode: string) {
    setCart((old) => old.filter((entry) => entry.code !== requestCode));
  }

  return (
    <main className="app-shell">
      <LanguageSwitcher language={language} onChange={setLanguage} />
      <header className="app-header no-print">
        <button className="brand brand-button" type="button" onClick={() => window.location.reload()} aria-label={tx("Reload materials page", "Recargar la página de materiales")}><img src="/crest-electrical-solutions-logo.png" alt="Crest Electrical Solutions" /></button>
        <div className="header-actions">
          <button className="button cart-button" onClick={() => setCartOpen(true)}>{tx("Cart", "Carrito")} <span>{cart.length}</span></button>
          <button className="button ghost" onClick={() => { setLookupMode(true); setModalOpen(true); }}>{transactionCopy("Change Request", "Change Return", "Cambiar solicitud", "Cambiar devolución")}</button>
          <button className="button secondary" disabled={saving} onClick={() => void save()}>{saving ? tx("Saving...", "Guardando...") : transactionCopy("Save Request Draft", "Save Return Draft", "Guardar borrador de solicitud", "Guardar borrador de devolución")}</button>
          <button className="button primary" disabled={saving} onClick={reviewPrint}>{transactionCopy("Print Request", "Print Return", "Imprimir solicitud", "Imprimir devolución")}</button>
        </div>
      </header>

      <section className="request-summary no-print">
        <div><span>{transactionCopy("REQUEST", "RETURN", "SOLICITUD", "DEVOLUCIÓN")}</span><strong>{code || tx("Generating...", "Generando...")}</strong></div>
        <div><span>{tx("NAME", "NOMBRE")}</span><strong>{name || "-"}</strong></div>
        <div><span>{tx("REQUESTER TYPE", "TIPO DE SOLICITANTE")}</span><strong>{department === "technical_service" ? tx("Technical Service", "Servicio Técnico") : tx("Subcontractor", "Subcontratista")}</strong></div>
        <div><span>{tx("WORK ORDER", "ORDEN DE TRABAJO")}</span><strong>{workOrder || tx("Optional", "Opcional")}</strong></div>
        <div><span>{tx("DATE", "FECHA")}</span><strong>{showDate(requestDate)}</strong></div>
        <button className="new-link" onClick={() => reset()}>+ {transactionCopy("New Request", "New Return", "Nueva solicitud", "Nueva devolución")}</button>
      </section>

      <section className="materials-workspace no-print">
        <div className="workspace-title">
          <div><p className="eyebrow">{transactionCopy("MATERIAL REQUEST", "MATERIAL RETURN", "SOLICITUD DE MATERIALES", "DEVOLUCIÓN DE MATERIALES")}</p><h1>{transactionCopy("Select Materials", "Select Materials to Return", "Seleccionar materiales", "Seleccionar materiales para devolver")}</h1><p>{transactionCopy("Search the list, filter by category, and enter quantities only for the materials needed.", "Search the list, filter by category, and enter the quantities being returned.", "Busque en la lista, filtre por categoría e ingrese cantidades solo para los materiales necesarios.", "Busque en la lista, filtre por categoría e ingrese las cantidades que se devolverán.")}</p></div>
          <div className="selection-stats"><span><b>{selected.length}</b> {tx("selected", "seleccionados")}</span><span><b>{totalUnits}</b> {tx("total units", "unidades totales")}</span></div>
        </div>
        <div className="material-filters">
          <label><span>{tx("Search material", "Buscar material")}</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={tx("Search by code, line, or description", "Buscar por código, línea o descripción")} /></label>
          <label><span>{tx("Category", "Categoría")}</span><select value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="ALL">{tx("All categories", "Todas las categorías")}</option>
            {categories.map((name) => <option key={name} value={name}>{language === "es" ? (spanishCategoryNames[name] || name) : name}</option>)}
          </select></label>
        </div>
        <div className="material-list" aria-live="polite">
          {!visible.length && <div className="empty-state">{tx("No materials match your search.", "No hay materiales que coincidan con su búsqueda.")}</div>}
          {group(visible).map((entry) => <section className="category-group" key={entry.name}>
            <h2>{language === "es" ? (spanishCategoryNames[entry.name] || entry.name) : entry.name}<span>{entry.rows.length} {tx("items", "artículos")}</span></h2>
            <div className="list-heading"><span>{tx("QTY", "CANT.")}</span><span>{tx("DESCRIPTION", "DESCRIPCIÓN")}</span><span>{tx("ITEM", "ARTÍCULO")}</span><span>{tx("CODE", "CÓDIGO")}</span></div>
            {entry.rows.map((item) => <div className={`material-row ${Number(quantities[item.key]) > 0 ? "selected" : ""}`} key={item.key}>
              <input inputMode="numeric" aria-label={tx(`Quantity for ${item.description}`, `Cantidad para ${item.description}`)} value={quantities[item.key] || ""} onChange={(event) => quantity(item.key, event.target.value)} placeholder="0" />
              <strong>{item.description}</strong><span className="item-number">{item.itemNumber || "-"}</span><span className="material-code">{item.code}</span>
            </div>)}
          </section>)}
        </div>
      </section>

      <div className="notice no-print" role="status"><span>●</span>{notice}</div>

      <section className="print-sheet" aria-hidden="true">
        <div className="print-brand-row"><img src="/crest-electrical-solutions-logo.png" alt="" /><div><h1>{isReturn ? "MATERIAL RETURN" : "MATERIAL REQUEST"}</h1><p>{code} - V{version}</p></div></div>
        <div className="print-meta">
          <div><span>NAME</span><strong>{name}</strong></div><div><span>ADDRESS</span><strong>{address}</strong></div>
          <div><span>REQUESTER TYPE</span><strong>{department === "technical_service" ? "TECHNICAL SERVICE" : "SUBCONTRACTOR"}</strong></div>
          <div><span>WORK ORDER</span><strong>{workOrder || "OPTIONAL"}</strong></div><div><span>DATE</span><strong>{showDate(requestDate)}</strong></div>
        </div>
        <table className="print-table"><thead><tr><th>QTY</th><th>CREST CAT#</th><th>ITEM NUMBER</th><th>L/N</th><th>DESCRIPTION</th></tr></thead>
          <tbody>{group(selected).map((entry) => <PrintRows key={entry.name} name={entry.name} rows={entry.rows} quantities={quantities} />)}</tbody>
        </table>
        <div className="print-footer"><span>{isReturn ? "Returned by" : "Requested by"}: {name}</span><span>Total items: {selected.length}</span><span>Total units: {totalUnits}</span></div>
      </section>

      <footer className="mobile-actions no-print"><button className="button cart-button" onClick={() => setCartOpen(true)}>{tx("Cart", "Carrito")} ({cart.length})</button><button className="button primary" onClick={reviewPrint}>{transactionCopy("Print Request", "Print Return", "Imprimir solicitud", "Imprimir devolución")}</button></footer>

      {checkoutOpen && <div className="modal-backdrop no-print"><section className="start-modal checkout-modal" role="dialog" aria-modal="true" aria-labelledby="checkout-title">
        <p className="eyebrow">{transactionCopy("REQUEST READY", "RETURN READY", "SOLICITUD LISTA", "DEVOLUCIÓN LISTA")}</p><h2 id="checkout-title">{transactionCopy("Would you like to add another request?", "Would you like to add another return?", "¿Desea agregar otra solicitud?", "¿Desea agregar otra devolución?")}</h2>
        <p className="modal-copy">{language === "es" ? `Esta ${isReturn ? "devolución" : "solicitud"} tiene ${selected.length} material${selected.length === 1 ? "" : "es"} seleccionado${selected.length === 1 ? "" : "s"}. Ya hay ${cart.length} transacción${cart.length === 1 ? "" : "es"} en el carrito.` : `This ${isReturn ? "return" : "request"} has ${selected.length} selected material${selected.length === 1 ? "" : "s"}. There ${cart.length === 1 ? "is" : "are"} already ${cart.length} transaction${cart.length === 1 ? "" : "s"} in the cart.`}</p>
        <div className="checkout-summary"><strong>{code}</strong><span>{address}</span><span>{department === "technical_service" ? tx("Technical Service", "Servicio Técnico") : tx("Subcontractor", "Subcontratista")} · WO {workOrder || tx("Optional", "Opcional")}</span></div>
        <div className="modal-actions checkout-actions">
          <button className="button ghost" onClick={() => setCheckoutOpen(false)}>{tx("Go Back", "Regresar")}</button>
          <button className="button secondary" onClick={addAnotherRequest}>{transactionCopy("Yes, Add Another Request", "Yes, Add Another Return", "Sí, agregar otra solicitud", "Sí, agregar otra devolución")}</button>
          <button className="button primary" disabled={saving} onClick={sendCurrentAndCart}>{tx("No, Send All", "No, enviar todas")} ({cart.length + 1})</button>
        </div>
      </section></div>}

      {cartOpen && <div className="modal-backdrop no-print"><section className="start-modal cart-modal" role="dialog" aria-modal="true" aria-labelledby="cart-title">
        <p className="eyebrow">{tx("MATERIALS CART", "CARRITO DE MATERIALES")}</p><h2 id="cart-title">{tx("Saved Transactions", "Transacciones guardadas")}</h2>
        <p className="modal-copy">{tx("These requests and returns are waiting to be sent.", "Estas solicitudes y devoluciones están esperando ser enviadas.")}</p>
        {!cart.length ? <div className="cart-empty">{tx("The cart is empty.", "El carrito está vacío.")}</div> : <div className="cart-list">{cart.map((request) => <article className="cart-item" key={request.code}>
          <div><strong>{request.address}</strong><span>{request.code} · {request.type === "return" ? tx("RETURN", "DEVOLUCIÓN") : tx("REQUEST", "SOLICITUD")}</span><span>{request.department === "subcontractor" ? tx("Subcontractor", "Subcontratista") : tx("Technical Service", "Servicio Técnico")} · WO {request.workOrder || tx("Optional", "Opcional")} · {request.items.length} {tx("items", "artículos")}</span></div>
          <button type="button" onClick={() => removeFromCart(request.code)} aria-label={tx(`Remove ${request.code} from cart`, `Eliminar ${request.code} del carrito`)}>{tx("Remove", "Eliminar")}</button>
        </article>)}</div>}
        <div className="modal-actions"><button className="button ghost" onClick={() => setCartOpen(false)}>{tx("Close", "Cerrar")}</button>{cart.length > 0 && <button className="button primary" disabled={saving} onClick={() => void sendRequests(cart)}>{tx("Send Cart", "Enviar carrito")} ({cart.length})</button>}</div>
      </section></div>}

      {modalOpen && <div className={`modal-backdrop ${portalOption === "breaker-swap" ? "breaker-modal-backdrop" : "no-print"}`}><section className={`start-modal ${portalOption === "breaker-swap" ? "breaker-modal" : ""}`} role="dialog" aria-modal="true" aria-labelledby="start-title">
        {!portalOption && <a className="button admin-panel admin-panel-modal" href="https://crest-material-reports.crest-5017.chatgpt.site/login">{tx("Admin Panel", "Panel Administrador")}</a>}
        <div className="modal-brand"><img src="/crest-electrical-solutions-logo.png" alt="Crest Electrical Solutions" /></div>
        {!portalOption ? <>
          <p className="eyebrow">{tx("MATERIALS PORTAL", "PORTAL DE MATERIALES")}</p><h2 id="start-title">{tx("Choose an option", "Elija una opción")}</h2><p className="modal-copy">{tx("Select the type of material transaction you need to process.", "Seleccione el tipo de transacción de materiales que necesita procesar.")}</p>
          <div className="modal-actions start-actions">
            <button className="button primary" onClick={() => { setTransactionType("request"); setPortalOption("request"); }}>{tx("Start Request", "Iniciar solicitud")}</button>
            <button className="button secondary" onClick={() => { setTransactionType("return"); setPortalOption("request"); }}>{tx("Start Return", "Iniciar devolución")}</button>
            <button className="button ghost" onClick={() => setPortalOption("breaker-swap")}>Breaker Swap</button>
          </div>
        </> : portalOption === "breaker-swap" ? <BreakerSwapPanel onBack={() => setPortalOption(null)} language={language} /> : !lookupMode && !deleteMode ? <>
          <p className="eyebrow">{transactionCopy("NEW MATERIAL REQUEST", "NEW MATERIAL RETURN", "NUEVA SOLICITUD DE MATERIALES", "NUEVA DEVOLUCIÓN DE MATERIALES")}</p><h2 id="start-title">{transactionCopy("Request Information", "Return Information", "Información de la solicitud", "Información de la devolución")}</h2><p className="modal-copy">{transactionCopy("Enter the job information before selecting materials.", "Enter the return information before selecting materials.", "Ingrese la información del trabajo antes de seleccionar materiales.", "Ingrese la información de la devolución antes de seleccionar materiales.")}</p>
          <div className="modal-fields">
            <label><span>{tx("Address", "Dirección")}</span><input autoFocus value={address} onChange={(event) => setAddress(event.target.value)} placeholder={tx("Jobsite address", "Dirección del lugar de trabajo")} /></label>
            <label><span>{tx("Requester Type", "Tipo de solicitante")}</span><select value={department} onChange={(event) => setDepartment(event.target.value === "subcontractor" ? "subcontractor" : "technical_service")}><option value="technical_service">{tx("Technical Service", "Servicio Técnico")}</option><option value="subcontractor">{tx("Subcontractor", "Subcontratista")}</option></select></label>
            <label><span>{tx("Work Order", "Orden de trabajo")} {department === "subcontractor" ? tx("(optional)", "(opcional)") : "*"}</span><input inputMode="numeric" pattern="[0-9]*" required={department === "technical_service"} value={workOrder} onChange={(event) => setWorkOrder(event.target.value.replace(/\D/g, ""))} placeholder={department === "subcontractor" ? tx("Optional — numbers only", "Opcional — solo números") : tx("Required — numbers only", "Obligatoria — solo números")} /></label>
            <label><span>{tx("Name", "Nombre")}</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder={transactionCopy("Requester name", "Person returning materials", "Nombre del solicitante", "Nombre de quien devuelve los materiales")} /></label>
            <label><span>{tx("Date", "Fecha")}</span><input value={showDate(requestDate)} readOnly /></label>
          </div>
          <div className="start-cart-panel">
            <div className="start-cart-title"><strong>{tx("Materials Cart", "Carrito de materiales")}</strong><span>{cart.length}</span></div>
            {!cart.length ? <p>{tx("The cart is empty.", "El carrito está vacío.")}</p> : <>
              <div className="start-cart-list">{cart.map((request) => <article className="cart-item" key={request.code}>
                <div><strong>{request.address}</strong><span>{request.code} · {request.type === "return" ? tx("RETURN", "DEVOLUCIÓN") : tx("REQUEST", "SOLICITUD")} · {request.department === "subcontractor" ? tx("Subcontractor", "Subcontratista") : tx("Technical Service", "Servicio Técnico")} · WO {request.workOrder || tx("Optional", "Opcional")} · {request.items.length} {tx("items", "artículos")}</span></div>
                <button type="button" onClick={() => removeFromCart(request.code)} aria-label={tx(`Remove ${request.code} from cart`, `Eliminar ${request.code} del carrito`)}>{tx("Remove", "Eliminar")}</button>
              </article>)}</div>
              <button className="button primary start-cart-send" disabled={saving} onClick={() => void sendRequests(cart)}>{tx("Send All Transactions", "Enviar todas las transacciones")} ({cart.length})</button>
            </>}
          </div>
          <div className="modal-actions start-actions"><button className="button danger" onClick={() => { setDeleteMode(true); setLookupMode(false); }}>{transactionCopy("Delete Request", "Delete Return", "Eliminar solicitud", "Eliminar devolución")}</button><button className="button ghost" onClick={() => { setLookupMode(true); setDeleteMode(false); }}>{transactionCopy("Change Request", "Change Return", "Cambiar solicitud", "Cambiar devolución")}</button><button className="button primary" disabled={saving} onClick={() => void start()}>{saving ? tx("Generating...", "Generando...") : transactionCopy("Start Request", "Start Return", "Iniciar solicitud", "Iniciar devolución")}</button></div>
        </> : lookupMode ? <>
          <p className="eyebrow">{transactionCopy("EXISTING REQUEST", "EXISTING RETURN", "SOLICITUD EXISTENTE", "DEVOLUCIÓN EXISTENTE")}</p><h2 id="start-title">{transactionCopy("Change Request", "Change Return", "Cambiar solicitud", "Cambiar devolución")}</h2><p className="modal-copy">{transactionCopy("Enter the unique code printed on the previous request.", "Enter the unique code printed on the previous return.", "Ingrese el código único impreso en la solicitud anterior.", "Ingrese el código único impreso en la devolución anterior.")}</p>
          <label className="lookup-field"><span>{transactionCopy("Request Code", "Return Code", "Código de solicitud", "Código de devolución")}</span><input autoFocus inputMode="numeric" value={lookupCode} onChange={(event) => setLookupCode(event.target.value.toUpperCase())} placeholder={tx("4-digit code", "Código de 4 dígitos")} /></label>
          <div className="modal-actions"><button className="button ghost" onClick={() => setLookupMode(false)}>{tx("Back", "Atrás")}</button><button className="button primary" disabled={saving} onClick={() => void openRequest()}>{saving ? tx("Opening...", "Abriendo...") : transactionCopy("Open Request", "Open Return", "Abrir solicitud", "Abrir devolución")}</button></div>
        </> : <>
          <p className="eyebrow danger-text">{transactionCopy("DELETE REQUEST", "DELETE RETURN", "ELIMINAR SOLICITUD", "ELIMINAR DEVOLUCIÓN")}</p><h2 id="start-title">{transactionCopy("Delete Request", "Delete Return", "Eliminar solicitud", "Eliminar devolución")}</h2><p className="modal-copy">{transactionCopy("Enter the request code. This permanently removes the request and all its saved versions from the database.", "Enter the return code. This permanently removes the return and all its saved versions from the database.", "Ingrese el código de la solicitud. Esto elimina permanentemente la solicitud y todas sus versiones guardadas de la base de datos.", "Ingrese el código de la devolución. Esto elimina permanentemente la devolución y todas sus versiones guardadas de la base de datos.")}</p>
          <label className="lookup-field"><span>{transactionCopy("Request Code", "Return Code", "Código de solicitud", "Código de devolución")}</span><input autoFocus inputMode="numeric" value={deleteCode} onChange={(event) => setDeleteCode(event.target.value.toUpperCase())} placeholder={tx("4-digit code", "Código de 4 dígitos")} /></label>
          <div className="delete-warning">{tx("This action cannot be undone.", "Esta acción no se puede deshacer.")}</div>
          <div className="modal-actions"><button className="button ghost" onClick={() => setDeleteMode(false)}>{tx("Back", "Atrás")}</button><button className="button danger" disabled={saving} onClick={() => void deleteRequest()}>{saving ? tx("Deleting...", "Eliminando...") : transactionCopy("Delete Request", "Delete Return", "Eliminar solicitud", "Eliminar devolución")}</button></div>
        </>}
        <div className="modal-notice" role="status">{notice}</div>
      </section></div>}
    </main>
  );
}

function PrintRows({ name, rows, quantities }: { name: string; rows: Item[]; quantities: QuantityMap }) {
  return <><tr className="print-category"><td colSpan={5}>{name}</td></tr>{rows.map((item) => <tr key={item.key}><td>{quantities[item.key]}</td><td>{item.code}</td><td>{item.itemNumber}</td><td>{item.line}</td><td>{item.description}</td></tr>)}</>;
}
