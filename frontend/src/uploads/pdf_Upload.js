// pdfUpload.js
export const PDF_EXTRACT_URL =
  import.meta.env.VITE_PDF_EXTRACT_URL || "http://127.0.0.1:8001/extract-pdf-images";

export function base64ToFile(base64, filename, mimeType = "image/png") {
  const byteString = atob(base64.split(",").pop());
  const ab = new ArrayBuffer(byteString.length);
  const ia = new Uint8Array(ab);

  for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);

  return new File([ab], filename, { type: mimeType });
}

export async function extractPdfImages({ pdfFile }) {
  const fd = new FormData();
  fd.append("file", pdfFile);

  const res = await fetch(PDF_EXTRACT_URL, { method: "POST", body: fd });
  if (!res.ok) throw new Error(`PDF extract failed (${res.status})`);

  const data = await res.json();
  return data.images; // ✅ return array only
}

export async function pickPdfToItems(pickedFiles, { makeItem }) {
  const pdf = Array.from(pickedFiles || []).find(
    (f) => f?.type === "application/pdf" || /\.pdf$/i.test(f?.name || "")
  );

  if (!pdf) return { error: "Please select a PDF file." };

  const extracted = await extractPdfImages({ pdfFile: pdf });

  const items = extracted.map((img, idx) => {
    const file = base64ToFile(
      img.dataBase64,
      img.name || `${pdf.name.replace(/\.pdf$/i, "")}-img-${idx + 1}.png`,
      img.contentType || "image/png"
    );
    return makeItem(file, `${pdf.name} • ${file.name}`, "pdfImage");
  });

  return {
    items,
    message: items.length ? `Extracted ${items.length} images.` : "No images extracted.",
  };
}
