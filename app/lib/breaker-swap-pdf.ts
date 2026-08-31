import { PDFDocument, StandardFonts, rgb } from "./vendor/pdf-lib.esm.min.js";
import { CREST_LOGO_PNG_BASE64 } from "./crest-logo-data.ts";

export type BreakerSwapPdfItem = {
  category: string;
  materialCode: string;
  itemNumber: string;
  lineNumber: string;
  description: string;
  quantity: number;
};

export type BreakerSwapPdfRequest = {
  address: string;
  supervisor: string;
  workOrder: string;
  swapDate: string;
  documentType: "outgoing" | "return";
  items?: BreakerSwapPdfItem[];
};

const LETTER_WIDTH = 612;
const LETTER_HEIGHT = 792;
const NAVY = rgb(0, 39 / 255, 91 / 255);
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

type WidthMeasurer = {
  widthOfTextAtSize: (text: string, size: number) => number;
};

function truncate(text: string, font: WidthMeasurer, size: number, maxWidth: number) {
  const clean = safeText(text);
  if (font.widthOfTextAtSize(clean, size) <= maxWidth) return clean;
  let result = clean;
  while (result.length > 1 && font.widthOfTextAtSize(`${result}...`, size) > maxWidth) result = result.slice(0, -1);
  return `${result.trimEnd()}...`;
}

export async function createBreakerSwapPdf(request: BreakerSwapPdfRequest) {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const logoBytes = Uint8Array.from(atob(CREST_LOGO_PNG_BASE64), (character) => character.charCodeAt(0));
  const logo = await pdf.embedPng(logoBytes);
  const page = pdf.addPage([LETTER_WIDTH, LETTER_HEIGHT]);
  const margin = 24;
  const tableWidth = LETTER_WIDTH - margin * 2;
  const columns = [42, 76, 112, 38, tableWidth - 268];
  const rowHeight = 18;
  let y = LETTER_HEIGHT - margin;

  function text(value: string, x: number, baseline: number, size = 8, font = regular, color = BLACK) {
    page.drawText(safeText(value), { x, y: baseline, size, font, color });
  }

  function box(x: number, top: number, width: number, height: number, fill = WHITE, border = BLACK, borderWidth = 0.6) {
    page.drawRectangle({ x, y: top - height, width, height, color: fill, borderColor: border, borderWidth });
  }

  page.drawImage(logo, { x: margin, y: y - 31, width: 150, height: 41.2 });
  const title = request.documentType === "return" ? "MATERIAL RETURN" : "MATERIAL PICKUP";
  text(title, LETTER_WIDTH - margin - bold.widthOfTextAtSize(title, 15), y - 15, 15, bold, NAVY);
  const previewLabel = request.documentType === "return" ? "BREAKER SWAP - PENDING RETURN" : "BREAKER SWAP - INVENTORY OUT";
  text(previewLabel, LETTER_WIDTH - margin - regular.widthOfTextAtSize(previewLabel, 7), y - 27, 7, regular, GRAY);
  y -= 40;
  page.drawLine({ start: { x: margin, y }, end: { x: LETTER_WIDTH - margin, y }, thickness: 2.2, color: NAVY });
  y -= 10;

  const meta = [
    { label: "ADDRESS", value: request.address, width: 230 },
    { label: "SUPERVISOR", value: request.supervisor, width: 150 },
    { label: "WORK ORDER", value: request.workOrder, width: 90 },
    { label: "DATE", value: displayDate(request.swapDate), width: tableWidth - 470 },
  ];
  let x = margin;
  meta.forEach((entry) => {
    box(x, y, entry.width, 36);
    text(entry.label, x + 5, y - 11, 5.5, bold, GRAY);
    text(truncate(entry.value, bold, 8, entry.width - 10), x + 5, y - 26, 8, bold);
    x += entry.width;
  });
  y -= 46;

  const labels = ["QTY", "CREST CAT#", "ITEM NUMBER", "L/N", "DESCRIPTION"];
  x = margin;
  labels.forEach((label, index) => {
    box(x, y, columns[index], 20, YELLOW);
    text(label, x + (columns[index] - bold.widthOfTextAtSize(label, 7)) / 2, y - 13, 7, bold);
    x += columns[index];
  });
  y -= 20;

  const items = request.items ?? [];
  if (items.length) {
    for (const item of items) {
      const values = [String(item.quantity), item.materialCode, item.itemNumber, item.lineNumber, item.description];
      x = margin;
      values.forEach((value, index) => {
        box(x, y, columns[index], rowHeight, WHITE, LIGHT_GRAY, 0.55);
        const clipped = truncate(value, regular, 7, columns[index] - 8);
        const valueX = index < 4 ? x + (columns[index] - regular.widthOfTextAtSize(clipped, 7)) / 2 : x + 5;
        text(clipped, valueX, y - 12, 7);
        x += columns[index];
      });
      y -= rowHeight;
    }
  } else {
    for (let row = 0; row < 8; row += 1) {
      x = margin;
      columns.forEach((width) => {
        box(x, y, width, rowHeight, WHITE, LIGHT_GRAY, 0.55);
        x += width;
      });
      y -= rowHeight;
    }
    text("No positive material quantities were found for this document.", margin + 8, y + 8 * rowHeight - 12, 7, regular, GRAY);
  }

  y -= 12;
  page.drawLine({ start: { x: margin, y }, end: { x: LETTER_WIDTH - margin, y }, thickness: 0.6, color: GRAY });
  text(`Address: ${request.address}`, margin, y - 14, 7, regular, GRAY);
  const totals = `Total items: ${items.length}   Total units: ${items.reduce((sum, item) => sum + item.quantity, 0)}`;
  text(totals, LETTER_WIDTH - margin - regular.widthOfTextAtSize(totals, 7), y - 14, 7, regular, GRAY);
  page.drawText("Page 1 of 1", { x: LETTER_WIDTH - margin - regular.widthOfTextAtSize("Page 1 of 1", 6), y: 16, size: 6, font: regular, color: GRAY });

  return pdf.save();
}

export async function createBreakerSwapPrintPdf(requests: BreakerSwapPdfRequest[]) {
  if (!requests.length) throw new Error("No Breaker Swap documents are available to print.");

  const combinedPdf = await PDFDocument.create();
  for (const request of requests) {
    const documentBytes = await createBreakerSwapPdf(request);
    const documentPdf = await PDFDocument.load(documentBytes);
    const pages = await combinedPdf.copyPages(documentPdf, documentPdf.getPageIndices());
    for (const page of pages) combinedPdf.addPage(page);
  }

  return combinedPdf.save();
}
