import { PDFDocument, StandardFonts, rgb } from "./vendor/pdf-lib.esm.min.js";
import { CREST_LOGO_PNG_BASE64 } from "./crest-logo-data.ts";

export type PdfMaterialItem = {
  category: string;
  material_code: string;
  item_number: string;
  line_number: string;
  description: string;
  quantity: number;
};

export type PdfMaterialRequest = {
  type: "request" | "return";
  code: string;
  name: string;
  address: string;
  department: "technical_service" | "subcontractor";
  workOrder: string;
  requestDate: string;
  version: number;
  items: PdfMaterialItem[];
};

const LETTER_WIDTH = 612;
const LETTER_HEIGHT = 792;
const NAVY = rgb(0, 39 / 255, 91 / 255);
const GREEN = rgb(98 / 255, 179 / 255, 66 / 255);
const YELLOW = rgb(1, 242 / 255, 0);
const BLACK = rgb(0, 0, 0);
const GRAY = rgb(90 / 255, 100 / 255, 112 / 255);
const LIGHT_GRAY = rgb(225 / 255, 230 / 255, 235 / 255);
const WHITE = rgb(1, 1, 1);

function safeText(value: unknown) {
  return String(value ?? "").replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").trim();
}

function displayDate(value: string) {
  const [year, month, day] = value.slice(0, 10).split("-");
  return year && month && day ? `${month}/${day}/${year}` : safeText(value);
}

function truncate(text: string, font: any, size: number, maxWidth: number) {
  const clean = safeText(text);
  if (font.widthOfTextAtSize(clean, size) <= maxWidth) return clean;
  let result = clean;
  while (result.length > 1 && font.widthOfTextAtSize(`${result}...`, size) > maxWidth) result = result.slice(0, -1);
  return `${result.trimEnd()}...`;
}

export async function createMaterialRequestPdf(request: PdfMaterialRequest) {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const logoBytes = Uint8Array.from(atob(CREST_LOGO_PNG_BASE64), (character) => character.charCodeAt(0));
  const logo = await pdf.embedPng(logoBytes);
  const margin = 24;
  const tableWidth = LETTER_WIDTH - margin * 2;
  const columns = [42, 76, 112, 38, tableWidth - 268];
  const rowHeight = 16;
  const categoryHeight = 18;
  const headerHeight = 18;
  const bottomLimit = 38;
  let page: any;
  let y = 0;
  let pageNumber = 0;

  function text(value: string, x: number, baseline: number, size = 8, font = regular, color = BLACK) {
    page.drawText(safeText(value), { x, y: baseline, size, font, color });
  }

  function box(x: number, top: number, width: number, height: number, fill?: unknown, border = BLACK, borderWidth = 0.6) {
    page.drawRectangle({ x, y: top - height, width, height, color: fill, borderColor: border, borderWidth });
  }

  function drawTableHeader() {
    const labels = ["QTY", "CREST CAT#", "ITEM NUMBER", "L/N", "DESCRIPTION"];
    let x = margin;
    labels.forEach((label, index) => {
      box(x, y, columns[index], headerHeight, YELLOW);
      const labelWidth = bold.widthOfTextAtSize(label, 7);
      text(label, x + (columns[index] - labelWidth) / 2, y - 12, 7, bold);
      x += columns[index];
    });
    y -= headerHeight;
  }

  function startPage(continued = false) {
    page = pdf.addPage([LETTER_WIDTH, LETTER_HEIGHT]);
    pageNumber += 1;
    y = LETTER_HEIGHT - margin;

    page.drawImage(logo, { x: margin, y: y - 31, width: 150, height: 41.2 });
    const documentTitle = request.type === "return" ? "MATERIAL RETURN" : "MATERIAL REQUEST";
    const title = continued ? `${documentTitle} - CONTINUED` : documentTitle;
    const titleWidth = bold.widthOfTextAtSize(title, 15);
    text(title, LETTER_WIDTH - margin - titleWidth, y - 15, 15, bold, NAVY);
    const requestLabel = `${request.code} - V${request.version}`;
    const requestWidth = regular.widthOfTextAtSize(requestLabel, 7);
    text(requestLabel, LETTER_WIDTH - margin - requestWidth, y - 27, 7, regular, GRAY);
    y -= 40;
    page.drawLine({ start: { x: margin, y }, end: { x: LETTER_WIDTH - margin, y }, thickness: 2.2, color: NAVY });
    y -= 10;

    const meta = [
      { label: "NAME", value: request.name, width: 104 },
      { label: "ADDRESS", value: request.address, width: 174 },
      { label: "DEPARTMENT", value: request.department === "subcontractor" ? "SUBCONTRACTOR" : "TECHNICAL SERVICE", width: 112 },
      { label: "WORK ORDER", value: request.workOrder || "OPTIONAL", width: 86 },
      { label: "DATE", value: displayDate(request.requestDate), width: tableWidth - 476 },
    ];
    let x = margin;
    meta.forEach((entry) => {
      box(x, y, entry.width, 34, WHITE);
      text(entry.label, x + 5, y - 10, 5.5, bold, GRAY);
      text(truncate(entry.value, bold, 7.5, entry.width - 10), x + 5, y - 24, 7.5, bold);
      x += entry.width;
    });
    y -= 44;
    drawTableHeader();
  }

  function ensureSpace(height: number) {
    if (y - height >= bottomLimit) return;
    startPage(true);
  }

  startPage(false);
  let currentCategory = "";
  for (const item of request.items) {
    const itemCategory = safeText(item.category) || "OTHER MATERIALS";
    if (itemCategory !== currentCategory) {
      ensureSpace(categoryHeight + rowHeight);
      currentCategory = itemCategory;
      box(margin, y, tableWidth, categoryHeight, NAVY, NAVY);
      text(truncate(currentCategory, bold, 7, tableWidth - 10), margin + 5, y - 12, 7, bold, WHITE);
      y -= categoryHeight;
    }
    ensureSpace(rowHeight);
    const values = [String(item.quantity), item.material_code, item.item_number, item.line_number, item.description];
    let x = margin;
    values.forEach((value, index) => {
      box(x, y, columns[index], rowHeight, WHITE, LIGHT_GRAY, 0.55);
      const alignedX = index < 4
        ? x + (columns[index] - regular.widthOfTextAtSize(truncate(value, regular, 7, columns[index] - 8), 7)) / 2
        : x + 5;
      text(truncate(value, regular, 7, columns[index] - 8), alignedX, y - 11, 7);
      x += columns[index];
    });
    y -= rowHeight;
  }

  const totalUnits = request.items.reduce((sum, item) => sum + item.quantity, 0);
  ensureSpace(28);
  y -= 10;
  page.drawLine({ start: { x: margin, y }, end: { x: LETTER_WIDTH - margin, y }, thickness: 0.6, color: GRAY });
  text(`${request.type === "return" ? "Returned" : "Requested"} by: ${request.name}`, margin, y - 13, 7, regular, GRAY);
  const totals = `Total items: ${request.items.length}   Total units: ${totalUnits}`;
  const totalsWidth = regular.widthOfTextAtSize(totals, 7);
  text(totals, LETTER_WIDTH - margin - totalsWidth, y - 13, 7, regular, GRAY);

  const pages = pdf.getPages();
  pages.forEach((pdfPage: any, index: number) => {
    const label = `Page ${index + 1} of ${pages.length}`;
    pdfPage.drawText(label, { x: LETTER_WIDTH - margin - regular.widthOfTextAtSize(label, 6), y: 16, size: 6, font: regular, color: GRAY });
  });

  return pdf.save();
}
