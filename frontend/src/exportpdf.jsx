// src/exportpdf.jsx
import {
  PDFDocument,
  StandardFonts,
  rgb,
  pushGraphicsState,
  popGraphicsState,
  rectangle,
  clip,
  endPath,
} from "pdf-lib";


/** ---------------- Helpers ---------------- **/

function extractProductCode(name = "") {
  if (name.includes("•")) name = name.split("•")[1].trim();
  name = name.replace(/\.(png|jpg|jpeg|webp)$/i, "");
  const match = name.match(/(LF)[-_ ]?(\d+)/i);
  if (!match) return name;
  const prefix = match[1].toUpperCase();
  const number = match[2].padStart(2, "0");
  return `${prefix}-${number}`;
}

function isDataUrl(url = "") {
  return typeof url === "string" && url.startsWith("data:");
}

function dataUrlToUint8Array(dataUrl) {
  const [, base64] = dataUrl.split(",");
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function fetchAsUint8Array(url) {
  const res = await fetch(url, { mode: "cors" });
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

async function getImageBytes(url) {
  if (!url) return null;
  if (isDataUrl(url)) return dataUrlToUint8Array(url);
  return fetchAsUint8Array(url);
}

function calcContainFit(imgW, imgH, boxW, boxH) {
  const scale = Math.min(boxW / imgW, boxH / imgH);
  const w = imgW * scale;
  const h = imgH * scale;
  const x = (boxW - w) / 2;
  const y = (boxH - h) / 2;
  return { w, h, x, y };
}

function drawImageClipped(page, img, box, drawX, drawY, drawW, drawH) {
  page.pushOperators(
    pushGraphicsState(),
    rectangle(box.x, box.y, box.w, box.h),
    clip(),
    endPath()
  );

  page.drawImage(img, { x: drawX, y: drawY, width: drawW, height: drawH });

  page.pushOperators(popGraphicsState());
}

function insetBox(box, inset = 10) {
  return {
    x: box.x + inset,
    y: box.y + inset,
    w: box.w - inset * 2,
    h: box.h - inset * 2,
  };
}

/** ---------------- Grid from Figma (TOP-LEFT origin) ---------------- **/

const GRID = {
  x_lines: {
    table_left: 16.52734375,
    code_right: 134.02734375,
    specified_right: 680.42822265625,
    table_right: 1236.38720703125,
  },
  rows: [
    { row_index: 0, y0: 309.30419921875, y1: 549.97802734375 },
    { row_index: 1, y0: 549.97802734375, y1: 791.5167846679688 },
    { row_index: 2, y0: 791.5167846679688, y1: 1032.26171875 },
    { row_index: 3, y0: 1032.26171875, y1: 1277.2332763671875 },
    { row_index: 4, y0: 1277.2332763671875, y1: 1518.890625 },
  ],
};

const ITEMS_PER_PAGE = 5;

// Padding inside cells so we don’t touch gridlines
const CELL_PAD = 12;

// Layout within SPECIFIED/SELECTED cells
// We’ll reserve a fixed-width image area inside each of those two cells,
// and put text in the remaining width on the right (selected cell only).
const IMAGE_AREA = {
  // percent of cell width (safe, avoids needing exact frame coords)
  specifiedPct: 0.42,
  selectedPct: 0.42,
  gap: 18, // gap between image and text
};

// Text styling
const FONT_SIZE = 11;
const LINE_GAP = 17;

// Code placement inside code cell
const CODE_FONT_SIZE = 10;
const CODE_TOP_PAD = 18;
const CODE_LEFT_PAD = 18;

/** Convert a top-left-origin cell to pdf-lib bottom-left-origin box */
function cellToPdfBox(cell, pageHeight) {
  const w = cell.x1 - cell.x0;
  const h = cell.y1 - cell.y0;
  return {
    x: cell.x0,
    y: pageHeight - cell.y1, // <-- key conversion
    w,
    h,
  };
}

function getCellTL(rowIndex, colName) {
  const xl = GRID.x_lines;
  const r = GRID.rows[rowIndex];
  if (!r) return null;

  const y0 = r.y0;
  const y1 = r.y1;

  if (colName === "code") {
    return { x0: xl.table_left, x1: xl.code_right, y0, y1 };
  }
  if (colName === "specified") {
    return { x0: xl.code_right, x1: xl.specified_right, y0, y1 };
  }
  if (colName === "selected") {
    return { x0: xl.specified_right, x1: xl.table_right, y0, y1 };
  }
  return null;
}

export async function exportCartToPdf(cart) {
  try {
    if (!cart?.length) {
      alert("Cart is empty.");
      return;
    }

    const templateBytes = await fetch("/PDF LAYOUT DESIGN.pdf").then((r) =>
      r.arrayBuffer()
    );

    // pristine source for copying clean pages
    const templateDoc = await PDFDocument.load(templateBytes);

    // output doc we draw into
    const outDoc = await PDFDocument.load(templateBytes);
    const font = await outDoc.embedFont(StandardFonts.Helvetica);

    // page size
    const firstPage = outDoc.getPages()[0];
    const { height: pageHeight } = firstPage.getSize();

    for (let i = 0; i < cart.length; i++) {
      // new page each 5 items
      if (i !== 0 && i % ITEMS_PER_PAGE === 0) {
        const [cleanPage] = await outDoc.copyPages(templateDoc, [0]);
        outDoc.addPage(cleanPage);
      }

      const pageIndex = Math.floor(i / ITEMS_PER_PAGE);
      const page = outDoc.getPages()[pageIndex];

      const pos = i % ITEMS_PER_PAGE;
      const row = cart[i];

      // ---- cart mapping (adjust if your keys differ) ----
      const specifiedUrl = row?.inputPreviewUrl || null;
      const selectedUrl = row?.chosen?.image_path || null;

      const code =
        extractProductCode(row?.inputName || "") ||
        extractProductCode(row?.inputPreviewUrl || "") || // optional fallback if name isn’t set
        row?.code ||
        row?.lfCode ||
        row?.itemCode ||
        row?.label ||
        row?.cartCode ||
        row?.chosen?.code ||
        row?.chosen?.lfCode ||
        `LF-${String(i + 2).padStart(2, "0")}`; // IMPORTANT: i, not pos


      const variantName = row?.chosen?.variant_name || "—";
      const brandName = row?.chosen?.brand_name || "—";
      let score = "—";
                  if (
                    row?.chosen?.bestScore !== undefined &&
                    row?.chosen?.bestScore !== null
                  ) {
                    const percent = row.chosen.bestScore * 100;
                    score = `${percent.toFixed(2)}%`;
                  }


      // ---- get grid cells (top-left origin) ----
      const codeCellTL = getCellTL(pos, "code");
      const specifiedCellTL = getCellTL(pos, "specified");
      const selectedCellTL = getCellTL(pos, "selected");

      if (!codeCellTL || !specifiedCellTL || !selectedCellTL) continue;

      // ---- convert to pdf-lib boxes ----
      const codeCell = insetBox(cellToPdfBox(codeCellTL, pageHeight), CELL_PAD);
      const specCell = insetBox(cellToPdfBox(specifiedCellTL, pageHeight), CELL_PAD);
      const selCell = insetBox(cellToPdfBox(selectedCellTL, pageHeight), CELL_PAD);

      // ---- CODE text (top-left inside cell) ----
      // pdf-lib draws from baseline, so place near top by using (y + h - pad)
      page.drawText(String(code), {
        x: codeCell.x + CODE_LEFT_PAD,
        y: codeCell.y + codeCell.h - CODE_TOP_PAD,
        size: CODE_FONT_SIZE,
        font,
        color: rgb(0, 0, 0),
      });

      // ---- SPECIFIED image inside specified cell ----
      // Reserve an "image area" on the left of the specified cell
      const specImgArea = {
        x: specCell.x,
        y: specCell.y,
        w: specCell.w * IMAGE_AREA.specifiedPct,
        h: specCell.h,
      };

      if (specifiedUrl) {
        const bytes = await getImageBytes(specifiedUrl).catch(() => null);
        if (bytes) {
          let img;
          try {
            img = await outDoc.embedPng(bytes);
          } catch {
            img = await outDoc.embedJpg(bytes);
          }

          const inner = insetBox(specImgArea, 8);
          const fit = calcContainFit(img.width, img.height, inner.w, inner.h);

          drawImageClipped(
            page,
            img,
            inner,
            inner.x + fit.x,
            inner.y + fit.y,
            fit.w,
            fit.h
          );
        }
      }

      // ---- SELECTED image + text inside selected cell ----
      const selImgArea = {
        x: selCell.x,
        y: selCell.y,
        w: selCell.w * IMAGE_AREA.selectedPct,
        h: selCell.h,
      };

      const selTextArea = {
        x: selCell.x + selImgArea.w + IMAGE_AREA.gap,
        y: selCell.y,
        w: selCell.w - selImgArea.w - IMAGE_AREA.gap,
        h: selCell.h,
      };

      if (selectedUrl) {
        const bytes = await getImageBytes(selectedUrl).catch(() => null);
        if (bytes) {
          let img;
          try {
            img = await outDoc.embedPng(bytes);
          } catch {
            img = await outDoc.embedJpg(bytes);
          }

          const inner = insetBox(selImgArea, 8);
          const fit = calcContainFit(img.width, img.height, inner.w, inner.h);

          drawImageClipped(
            page,
            img,
            inner,
            inner.x + fit.x,
            inner.y + fit.y,
            fit.w,
            fit.h
          );
        }
      }

      // Text block: align near vertical center in text area
      const textStartY = selTextArea.y + selTextArea.h * 0.62;

      page.drawText(`PRODUCT: ${variantName}`, {
        x: selTextArea.x,
        y: textStartY,
        size: FONT_SIZE,
        font,
        color: rgb(0, 0, 0),
      });

      page.drawText(`BRAND: ${brandName}`, {
        x: selTextArea.x,
        y: textStartY - LINE_GAP,
        size: FONT_SIZE,
        font,
        color: rgb(0, 0, 0),
      });

      page.drawText(`MATCH ACCURACY: ${score}`, {
        x: selTextArea.x,
        y: textStartY - LINE_GAP * 2,
        size: FONT_SIZE,
        font,
        color: rgb(0, 0, 0),
      });
    }

    // Download
    const out = await outDoc.save();
    const blob = new Blob([out], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = "cart-export.pdf";
    a.click();

    URL.revokeObjectURL(url);
  } catch (err) {
    console.error("Template PDF export failed:", err);
    alert("Template PDF export failed. Check console for details.");
  }
}
