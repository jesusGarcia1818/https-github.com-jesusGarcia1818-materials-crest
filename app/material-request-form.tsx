"use client";

import { useEffect, useMemo, useState } from "react";
import materialRows from "./materials.json";
import materialItemNumbers from "./material-item-numbers.json";

type QuantityMap = Record<string, string>;
type RequestType = "request" | "return";
type Item = { key: string; sourceRow: number; groupIndex: number; legacyCode: string; code: string; itemNumber: string; line: string; description: string; category: string };
type SavedRequest = { code: string; name: string; address: string; workOrder?: string; requestDate?: string; quantities: QuantityMap; version: number };
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
  code: string;
  name: string;
  address: string;
  workOrder: string;
  requestDate: string;
  version: number;
  items: RequestItemPayload[];
};

const cartStorageKey = "crest-material-request-cart-v1";

function localDate() {
  const date = new Date();
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function showDate(value: string) {
  if (!value) return "";
  const [year, month, day] = value.slice(0, 10).split("-");
  return `${month}/${day}/${year}`;
}
function itemNumberFor(code: string) {
  const normalized = code.trim().toUpperCase();
  const mapping = materialItemNumbers as Record<string, string>;
  return mapping[normalized] || mapping[normalized.replace(/\.\d+$/, "")] || "";
}

const items: Item[] = (() => {
  const current = ["OTHER MATERIALS", "OTHER MATERIALS", "OTHER MATERIALS"];
  const result: Item[] = [];
  materialRows.forEach((row) => row.groups.forEach((material, groupIndex) => {
    if (material.category) current[groupIndex] = material.category;
    else if (material.code.trim() && material.description.trim()) result.push({
      key: `${row.sourceRow}-${groupIndex}`, sourceRow: row.sourceRow, groupIndex,
      legacyCode: row.legacyCode, code: material.code, itemNumber: itemNumberFor(material.code), line: material.line,
      description: material.description, category: current[groupIndex],
    });
  }));
  return result;
})();
const categories = Array.from(new Set(items.map((item) => item.category)));

export function MaterialRequestForm() {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
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
  const [requestType, setRequestType] = useState<RequestType | null>(null);

  useEffect(() => {
    if (!requestType) { setCart([]); return; }
    const storageKey = `${cartStorageKey}-${requestType}`;
    try {
      const stored = window.sessionStorage.getItem(storageKey);
      setCart(stored && Array.isArray(JSON.parse(stored)) ? JSON.parse(stored) as CartRequest[] : []);
    } catch {
      window.sessionStorage.removeItem(storageKey);
      setCart([]);
    }
  }, [requestType]);

  useEffect(() => {
    if (!requestType) return;
    const storageKey = `${cartStorageKey}-${requestType}`;
    if (cart.length) window.sessionStorage.setItem(storageKey, JSON.stringify(cart));
    else window.sessionStorage.removeItem(storageKey);
  }, [cart, requestType]);

  const selected = useMemo(() => items.filter((item) => Number(quantities[item.key]) > 0), [quantities]);
  const totalUnits = useMemo(() => selected.reduce((sum, item) => sum + Number(quantities[item.key]), 0), [selected, quantities]);
  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return items.filter((item) => (category === "ALL" || item.category === category) &&
      (!term || `${item.code} ${item.itemNumber} ${item.line} ${item.description} ${item.legacyCode} ${item.category}`.toLowerCase().includes(term)));
  }, [search, category]);
  const group = (list: Item[]) => categories.map((groupName) => ({ name: groupName, rows: list.filter((item) => item.category === groupName) })).filter((entry) => entry.rows.length);

  function valid() {
    if (address.trim().length < 2 || !/^\d+$/.test(workOrder.trim()) || name.trim().length < 2 || !/^\d{4}-\d{2}-\d{2}$/.test(requestDate)) {
      setNotice("Complete Address, a numeric Work Order, Name, and Date before starting.");
      return false;
    }
    return true;
  }
  async function allocateCode() {
    const response = await fetch("/api/material-requests?allocate=1", { cache: "no-store" });
    const payload = await response.json() as { code?: string; error?: string };
    if (!response.ok || !payload.code) throw new Error(payload.error || "A request number could not be generated.");
    return payload.code;
  }
  async function start() {
    if (!valid()) return;
    setSaving(true); setNotice("Generating a unique request number...");
    try {
      const requestCode = await allocateCode();
      setCode(requestCode);
      setModalOpen(false);
      setNotice(`Request ${requestCode} is ready for material selection.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "A request number could not be generated.");
    } finally { setSaving(false); }
  }
  function reset(preservedName = "") {
    setCode(""); setName(preservedName); setAddress(""); setWorkOrder(""); setRequestDate(localDate());
    setQuantities({}); setVersion(1); setSearch(""); setCategory("ALL"); setLookupCode(""); setDeleteCode("");
    setLookupMode(false); setDeleteMode(false); setModalOpen(true); setNotice("Complete the information to begin.");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function quantity(key: string, value: string) {
    if (value === "" || /^\d+$/.test(value)) setQuantities((old) => ({ ...old, [key]: value }));
  }

  function currentRequest(requireItems = true): CartRequest | null {
    if (!requestType || !valid()) return null;
    if (!/^(?:\d{4}|MAT-[0-9]{8}-[A-Z0-9]{4,12})$/.test(code)) { setNotice("The request number is not ready. Start the request again."); return null; }
    if (requireItems && !selected.length) { setNotice("Select at least one material before printing."); return null; }
    const requestItems: RequestItemPayload[] = selected.map((item) => ({
      material_key: item.key, source_row: item.sourceRow, group_index: item.groupIndex,
      legacy_code: item.legacyCode, material_code: item.code, item_number: item.itemNumber, line_number: item.line,
      description: item.description, category: item.category, quantity: requestType === "return" ? -Number(quantities[item.key]) : Number(quantities[item.key]),
    }));
    return { code, name: name.trim(), address: address.trim(), workOrder: workOrder.trim(), requestDate, version, items: requestItems };
  }

  async function submitRequest(request: CartRequest, status: "draft" | "printed") {
    const normalizedRequest = { ...request, items: request.items.map((item) => ({ ...item, item_number: item.item_number || itemNumberFor(item.material_code) })) };
    const response = await fetch("/api/material-requests", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...normalizedRequest, type: requestType || "request", status }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "The request could not be saved.");
  }

  async function save(status: "draft" | "printed" = "draft") {
    const request = currentRequest(status === "printed");
    if (!request) return false;
    setSaving(true); setNotice(status === "printed" ? "Creating PDF and sending request by email..." : "Saving request...");
    try {
      await submitRequest(request, status);
      setNotice(status === "printed" ? `${requestType === "return" ? "Return" : "Request"} sent successfully to materials@dfwcrest.com.` : "Draft saved successfully.");
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The request could not be saved.");
      return false;
    } finally { setSaving(false); }
  }

  async function openRequest() {
    const normalized = lookupCode.trim().toUpperCase();
    if (!normalized) { setNotice("Enter the request code."); return; }
    setSaving(true); setNotice("Opening request...");
    try {
      const response = await fetch(`/api/material-requests?code=${encodeURIComponent(normalized)}`, { cache: "no-store" });
      const record = await response.json() as SavedRequest & { error?: string };
      if (!response.ok) throw new Error(record.error || "Request not found.");
      setCode(record.code); setName(record.name); setAddress(record.address);
      setWorkOrder(record.workOrder || ""); setRequestDate(record.requestDate?.slice(0, 10) || localDate());
      setQuantities(record.quantities || {}); setVersion(record.version + 1);
      setModalOpen(false); setLookupMode(false);
      setNotice(`Request ${record.code} opened - version ${record.version + 1}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The request could not be opened.");
    } finally { setSaving(false); }
  }
  async function deleteRequest() {
    const normalized = deleteCode.trim().toUpperCase();
    if (!normalized) { setNotice("Enter the request code to delete."); return; }
    setSaving(true); setNotice("Deleting request...");
    try {
      const response = await fetch(`/api/material-requests?code=${encodeURIComponent(normalized)}`, { method: "DELETE" });
      const payload = await response.json() as { code?: string; error?: string };
      if (!response.ok) throw new Error(payload.error || "The request could not be deleted.");
      setCart((old) => old.filter((entry) => entry.code !== normalized));
      reset();
      setNotice(`Request ${normalized} was deleted from the database.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The request could not be deleted.");
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
    setNotice(`${request.code} was added to the cart. Enter the next job information.`);
  }

  async function sendRequests(requests: CartRequest[]) {
    if (!requests.length) return;
    setSaving(true);
    setCheckoutOpen(false);
    setCartOpen(false);
    try {
      for (let index = 0; index < requests.length; index += 1) {
        setNotice(`Sending request ${index + 1} of ${requests.length}...`);
        await submitRequest(requests[index], "printed");
      }
      setCart([]);
      reset();
      setNotice(`${requests.length} ${requestType === "return" ? "return" : "request"}${requests.length === 1 ? "" : "s"} sent successfully to materials@dfwcrest.com. Cart is empty.`);
    } catch (error) {
      setNotice(error instanceof Error ? `${error.message} The cart was kept so you can try again.` : "The requests could not be sent. The cart was kept.");
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
      <header className="app-header no-print">
        <button className="brand brand-button" type="button" onClick={() => window.location.reload()} aria-label="Reload material request page"><img src="/crest-electrical-solutions-logo.png" alt="Crest Electrical Solutions" /></button>
        <div className="header-actions">
          <button className="button cart-button" onClick={() => setCartOpen(true)}>Cart <span>{cart.length}</span></button>
          <button className="button ghost" onClick={() => { setLookupMode(true); setModalOpen(true); }}>Change Request</button>
          <button className="button secondary" disabled={saving} onClick={() => void save()}>{saving ? "Saving..." : "Save Draft"}</button>
          <button className="button primary" disabled={saving} onClick={reviewPrint}>Print Request</button>
        </div>
      </header>

      <section className="request-summary no-print">
        <div><span>REQUEST</span><strong>{code || "Generating..."}</strong></div>
        <div><span>NAME</span><strong>{name || "-"}</strong></div>
        <div><span>WORK ORDER</span><strong>{workOrder || "-"}</strong></div>
        <div><span>DATE</span><strong>{showDate(requestDate)}</strong></div>
        <button className="new-link" onClick={() => reset()}>+ New Request</button>
      </section>

      <section className="materials-workspace no-print">
        <div className="workspace-title">
          <div><p className="eyebrow">{requestType === "return" ? "MATERIAL RETURN" : "MATERIAL REQUEST"}</p><h1>{requestType === "return" ? "Return Materials" : "Select Materials"}</h1><p>Search the list, filter by category, and enter quantities only for the materials needed.</p></div>
          <div className="selection-stats"><span><b>{selected.length}</b> selected</span><span><b>{totalUnits}</b> total units</span></div>
        </div>
        <div className="material-filters">
          <label><span>Search material</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by code, line, or description" /></label>
          <label><span>Category</span><select value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="ALL">All categories</option>
            {categories.map((name) => <option key={name} value={name}>{name}</option>)}
          </select></label>
        </div>
        <div className="material-list" aria-live="polite">
          {!visible.length && <div className="empty-state">No materials match your search.</div>}
          {group(visible).map((entry) => <section className="category-group" key={entry.name}>
            <h2>{entry.name}<span>{entry.rows.length} items</span></h2>
            <div className="list-heading"><span>QTY</span><span>CREST CAT#</span><span>ITEM NUMBER</span><span>L/N</span><span>DESCRIPTION</span></div>
            {entry.rows.map((item) => <div className={`material-row ${Number(quantities[item.key]) > 0 ? "selected" : ""}`} key={item.key}>
              <input inputMode="numeric" aria-label={`Quantity for ${item.description}`} value={quantities[item.key] || ""} onChange={(event) => quantity(item.key, event.target.value)} placeholder="0" />
              <span className="material-code">{item.code}</span><span className="item-number">{item.itemNumber || "-"}</span><span>{item.line || "-"}</span><strong>{item.description}</strong>
            </div>)}
          </section>)}
        </div>
      </section>

      <div className="notice no-print" role="status"><span>â—</span>{notice}</div>

      <section className="print-sheet" aria-hidden="true">
        <div className="print-brand-row"><img src="/crest-electrical-solutions-logo.png" alt="" /><div><h1>{requestType === "return" ? "MATERIAL RETURN" : "MATERIAL REQUEST"}</h1><p>{code} - V{version}</p></div></div>
        <div className="print-meta">
          <div><span>NAME</span><strong>{name}</strong></div><div><span>ADDRESS</span><strong>{address}</strong></div>
          <div><span>WORK ORDER</span><strong>{workOrder}</strong></div><div><span>DATE</span><strong>{showDate(requestDate)}</strong></div>
        </div>
        <table className="print-table"><thead><tr><th>QTY</th><th>CREST CAT#</th><th>ITEM NUMBER</th><th>L/N</th><th>DESCRIPTION</th></tr></thead>
          <tbody>{group(selected).map((entry) => <PrintRows key={entry.name} name={entry.name} rows={entry.rows} quantities={quantities} />)}</tbody>
        </table>
        <div className="print-footer"><span>Requested by: {name}</span><span>Total items: {selected.length}</span><span>Total units: {totalUnits}</span></div>
      </section>

      <footer className="mobile-actions no-print"><button className="button cart-button" onClick={() => setCartOpen(true)}>Cart ({cart.length})</button><button className="button primary" onClick={reviewPrint}>Print</button></footer>

      {checkoutOpen && <div className="modal-backdrop no-print"><section className="start-modal checkout-modal" role="dialog" aria-modal="true" aria-labelledby="checkout-title">
        <p className="eyebrow">{requestType === "return" ? "RETURN READY" : "REQUEST READY"}</p><h2 id="checkout-title">Would you like to add another {requestType === "return" ? "return" : "request"}?</h2>
        <p className="modal-copy">This request has {selected.length} selected material{selected.length === 1 ? "" : "s"}. There {cart.length === 1 ? "is" : "are"} already {cart.length} request{cart.length === 1 ? "" : "s"} in the cart.</p>
        <div className="checkout-summary"><strong>{code}</strong><span>{address}</span><span>WO {workOrder}</span></div>
        <div className="modal-actions checkout-actions">
          <button className="button ghost" onClick={() => setCheckoutOpen(false)}>Go Back</button>
          <button className="button secondary" onClick={addAnotherRequest}>Yes, Add Another</button>
          <button className="button primary" disabled={saving} onClick={sendCurrentAndCart}>No, Send All ({cart.length + 1})</button>
        </div>
      </section></div>}

      {cartOpen && <div className="modal-backdrop no-print"><section className="start-modal cart-modal" role="dialog" aria-modal="true" aria-labelledby="cart-title">
        <p className="eyebrow">REQUEST CART</p><h2 id="cart-title">Saved Requests</h2>
        <p className="modal-copy">These requests are waiting to be sent.</p>
        {!cart.length ? <div className="cart-empty">The cart is empty.</div> : <div className="cart-list">{cart.map((request) => <article className="cart-item" key={request.code}>
          <div><strong>{request.address}</strong><span>{request.code}</span><span>WO {request.workOrder} Â· {request.items.length} items</span></div>
          <button type="button" onClick={() => removeFromCart(request.code)} aria-label={`Remove ${request.code} from cart`}>Remove</button>
        </article>)}</div>}
        <div className="modal-actions"><button className="button ghost" onClick={() => setCartOpen(false)}>Close</button>{cart.length > 0 && <button className="button primary" disabled={saving} onClick={() => void sendRequests(cart)}>Send Cart ({cart.length})</button>}</div>
      </section></div>}

      {modalOpen && <div className="modal-backdrop no-print"><section className="start-modal" role="dialog" aria-modal="true" aria-labelledby="start-title">
        <a className="button admin-panel admin-panel-modal" href="https://crest-material-reports.crest-5017.chatgpt.site/login">Panel Administrador</a>
        <div className="modal-brand"><img src="/crest-electrical-solutions-logo.png" alt="Crest Electrical Solutions" /></div>
        {!requestType ? <>
          <p className="eyebrow">MATERIALS PORTAL</p><h2 id="start-title">Choose an option</h2><p className="modal-copy">Select the type of material transaction you need to process.</p>
          <div className="modal-actions start-actions">
            <button className="button primary" onClick={() => { setRequestType("request"); setLookupMode(false); setDeleteMode(false); }}>Start Request</button>
            <button className="button secondary" onClick={() => { setRequestType("return"); setLookupMode(false); setDeleteMode(false); }}>Return</button>
            <button className="button ghost" disabled title="Coming soon">Breaker Swap</button>
          </div>
        </> : !lookupMode && !deleteMode ? <>
          <p className="eyebrow">{requestType === "return" ? "MATERIAL RETURN" : "NEW MATERIAL REQUEST"}</p><h2 id="start-title">{requestType === "return" ? "Return Information" : "Request Information"}</h2><p className="modal-copy">Enter the job information before selecting materials.</p>
          <div className="modal-fields">
            <label><span>Address</span><input autoFocus value={address} onChange={(event) => setAddress(event.target.value)} placeholder="Jobsite address" /></label>
            <label><span>Work Order</span><input inputMode="numeric" pattern="[0-9]*" value={workOrder} onChange={(event) => setWorkOrder(event.target.value.replace(/\D/g, ""))} placeholder="Numbers only" /></label>
            <label><span>Name</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Requester name" /></label>
            <label><span>Date</span><input value={showDate(requestDate)} readOnly /></label>
          </div>
          <div className="start-cart-panel">
            <div className="start-cart-title"><strong>Request Cart</strong><span>{cart.length}</span></div>
            {!cart.length ? <p>The cart is empty.</p> : <>
              <div className="start-cart-list">{cart.map((request) => <article className="cart-item" key={request.code}>
                <div><strong>{request.address}</strong><span>{request.code} Â· WO {request.workOrder} Â· {request.items.length} items</span></div>
                <button type="button" onClick={() => removeFromCart(request.code)} aria-label={`Remove ${request.code} from cart`}>Remove</button>
              </article>)}</div>
              <button className="button primary start-cart-send" disabled={saving} onClick={() => void sendRequests(cart)}>Send All Requests ({cart.length})</button>
            </>}
          </div>
          <div className="modal-actions start-actions"><button className="button danger" onClick={() => { setDeleteMode(true); setLookupMode(false); }}>Delete Request</button><button className="button ghost" onClick={() => { setLookupMode(true); setDeleteMode(false); }}>Change Request</button><button className="button primary" disabled={saving} onClick={() => void start()}>{saving ? "Generating..." : requestType === "return" ? "Start Return" : "Start Request"}</button></div>
        </> : lookupMode ? <>
          <p className="eyebrow">EXISTING REQUEST</p><h2 id="start-title">Change Request</h2><p className="modal-copy">Enter the unique code printed on the previous request.</p>
          <label className="lookup-field"><span>Request Code</span><input autoFocus inputMode="numeric" value={lookupCode} onChange={(event) => setLookupCode(event.target.value.toUpperCase())} placeholder="4-digit code" /></label>
          <div className="modal-actions"><button className="button ghost" onClick={() => setLookupMode(false)}>Back</button><button className="button primary" disabled={saving} onClick={() => void openRequest()}>{saving ? "Opening..." : "Open Request"}</button></div>
        </> : <>
          <p className="eyebrow danger-text">DELETE REQUEST</p><h2 id="start-title">Delete Request</h2><p className="modal-copy">Enter the request code. This permanently removes the request and all its saved versions from the database.</p>
          <label className="lookup-field"><span>Request Code</span><input autoFocus inputMode="numeric" value={deleteCode} onChange={(event) => setDeleteCode(event.target.value.toUpperCase())} placeholder="4-digit code" /></label>
          <div className="delete-warning">This action cannot be undone.</div>
          <div className="modal-actions"><button className="button ghost" onClick={() => setDeleteMode(false)}>Back</button><button className="button danger" disabled={saving} onClick={() => void deleteRequest()}>{saving ? "Deleting..." : "Delete Request"}</button></div>
        </>}
        <div className="modal-notice" role="status">{notice}</div>
      </section></div>}
    </main>
  );
}

function PrintRows({ name, rows, quantities }: { name: string; rows: Item[]; quantities: QuantityMap }) {
  return <><tr className="print-category"><td colSpan={5}>{name}</td></tr>{rows.map((item) => <tr key={item.key}><td>{quantities[item.key]}</td><td>{item.code}</td><td>{item.itemNumber}</td><td>{item.line}</td><td>{item.description}</td></tr>)}</>;
}

