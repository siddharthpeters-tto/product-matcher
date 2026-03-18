// src/extractScheduleImagesFromPdf.js
import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorker from "pdfjs-dist/build/pdf.worker?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

/**
 * Render a PDF page to canvas.
 */
async function renderPageToCanvas(page, scale = 1.8) {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { alpha: false });

  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  if (!ctx) throw new Error("2D canvas not available");

  await page.render({ canvasContext: ctx, viewport }).promise;
  return { canvas, ctx, viewport };
}

/**
 * Find horizontal grid lines by scanning for dark pixels across each row.
 * Returns sorted y positions.
 */
function detectHorizontalLines(imageData, width, height, opts = {}) {
  const {
    // how much of the row must be "dark" to count as a line
    darkRowRatio = 0.55,
    // pixel is dark if below this
    darkThreshold = 120,
    // merge nearby detections
    mergeDistance = 6,
    // ignore top/bottom margins
    marginTop = 0.04,
    marginBottom = 0.04,
  } = opts;

  const data = imageData.data;
  const ys = [];

  const yStart = Math.floor(height * marginTop);
  const yEnd = Math.ceil(height * (1 - marginBottom));

  for (let y = yStart; y < yEnd; y++) {
    let darkCount = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      // simple luminance
      const lum = (r * 0.299 + g * 0.587 + b * 0.114) | 0;
      if (lum < darkThreshold) darkCount++;
    }
    if (darkCount / width >= darkRowRatio) ys.push(y);
  }

  // merge consecutive y positions into single lines
  const merged = [];
  for (const y of ys) {
    const last = merged[merged.length - 1];
    if (last == null || Math.abs(y - last) > mergeDistance) merged.push(y);
  }
  return merged;
}

/**
 * Crop a canvas rect -> Blob.
 */
async function cropCanvasToBlob(canvas, rect, { mime = "image/jpeg", quality = 0.9 } = {}) {
  const { x, y, w, h } = rect;
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.floor(w));
  out.height = Math.max(1, Math.floor(h));
  const ctx = out.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("2D canvas not available");

  ctx.drawImage(canvas, x, y, w, h, 0, 0, out.width, out.height);

  const blob = await new Promise((resolve, reject) => {
    out.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob returned null"))),
      mime,
      quality
    );
  });

  // free memory
  out.width = 1;
  out.height = 1;

  return blob;
}

/**
 * Extract product images from a schedule page by:
 *  - detecting horizontal lines
 *  - cropping a fixed image column in each row segment
 *
 * You MUST tune imageColumnX for your layout.
 */
export async function extractScheduleImagesFromPdf(pdfFile, opts = {}) {
  const {
    scale = 1.8,
    mime = "image/jpeg",
    quality = 0.9,
    maxPages = 200,
    // image column bounds as fraction of page width (tune these!)
    imageColumnX = { left: 0.14, right: 0.40 },
    // avoid tiny crops
    minRowHeightPx = 90,
    // remove header/footer bands
    cropMargins = { top: 0.06, bottom: 0.06 },
    // line detection tuning
    lineDetect = {},
    onProgress = null, // ({phase, pageIndex, pagesTotal, extractedSoFar}) => void
    signal = null,
  } = opts;

  if (!pdfFile) throw new Error("No PDF file provided");
  const ab = await pdfFile.arrayBuffer();
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const loadingTask = pdfjsLib.getDocument({ data: ab });
  if (signal) {
    signal.addEventListener(
      "abort",
      () => {
        try { loadingTask.destroy(); } catch {}
      },
      { once: true }
    );
  }

  const pdf = await loadingTask.promise;
  const totalPages = Math.min(pdf.numPages, maxPages);

  const baseName = (pdfFile.name || "document.pdf").replace(/\.pdf$/i, "");
  const outputs = [];
  let extractedSoFar = 0;

  for (let p = 1; p <= totalPages; p++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    onProgress?.({ phase: "render", pageIndex: p - 1, pagesTotal: totalPages, extractedSoFar });

    const page = await pdf.getPage(p);
    const { canvas, ctx } = await renderPageToCanvas(page, scale);

    // clamp to region that likely contains the table
    const W = canvas.width;
    const H = canvas.height;
    const topY = Math.floor(H * cropMargins.top);
    const bottomY = Math.floor(H * (1 - cropMargins.bottom));
    const h2 = Math.max(1, bottomY - topY);

    const imageData = ctx.getImageData(0, topY, W, h2);
    const lines = detectHorizontalLines(imageData, W, h2, lineDetect)
      .map((y) => y + topY);

    // build row segments between lines
    // (include top/bottom bounds so we get first/last rows)
    const bounds = [topY, ...lines, bottomY]
      .sort((a, b) => a - b)
      .filter((y, i, arr) => i === 0 || y - arr[i - 1] > 4);

    const xLeft = Math.floor(W * imageColumnX.left);
    const xRight = Math.floor(W * imageColumnX.right);
    const colW = Math.max(1, xRight - xLeft);

    for (let i = 0; i < bounds.length - 1; i++) {
      const y1 = bounds[i];
      const y2 = bounds[i + 1];
      const rowH = y2 - y1;

      if (rowH < minRowHeightPx) continue;

      // crop slightly inside the row to avoid grid lines
      const inset = 3;
      const rect = {
        x: xLeft + inset,
        y: y1 + inset,
        w: colW - inset * 2,
        h: rowH - inset * 2,
      };

      // skip if invalid
      if (rect.w < 40 || rect.h < 40) continue;

      const blob = await cropCanvasToBlob(canvas, rect, { mime, quality });
      const fileName = `${baseName}-p${String(p).padStart(3, "0")}-img${String(i + 1).padStart(2, "0")}.jpg`;
      const file = new File([blob], fileName, { type: blob.type || mime });
      const previewUrl = URL.createObjectURL(blob);

      outputs.push({
        sourceName: `${pdfFile.name} (page ${p}/${totalPages}, row ${i + 1})`,
        file,
        previewUrl,
        pageNumber: p,
        rowIndex: i + 1,
      });

      extractedSoFar++;
      onProgress?.({ phase: "extract", pageIndex: p - 1, pagesTotal: totalPages, extractedSoFar });
    }

    // free canvas
    canvas.width = 1;
    canvas.height = 1;

    // yield
    if (p % 2 === 0) await new Promise((r) => setTimeout(r, 0));
  }

  onProgress?.({ phase: "done", pageIndex: totalPages - 1, pagesTotal: totalPages, extractedSoFar });
  return outputs;
}
