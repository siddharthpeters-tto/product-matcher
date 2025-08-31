// CropImage.js — takes a crop in ORIGINAL IMAGE PIXELS and returns a Blob
// Works with BoxCropper.toImagePixels({x,y,width,height}) output.
export default async function getCroppedImg(imageSrc, crop, opts = {}) {
  const {
    mime = "image/jpeg",
    quality = 0.92, // 0–1
    maxSize = 2048, // clamp the longest edge to avoid giant canvases
    background = null, // e.g. "#fff" to flatten PNGs
  } = opts;

  if (
    !crop ||
    typeof crop.x !== "number" ||
    typeof crop.y !== "number" ||
    typeof crop.width !== "number" ||
    typeof crop.height !== "number"
  ) {
    throw new Error("Invalid crop (expected {x,y,width,height} in natural pixels)");
  }

  const image = await loadImage(imageSrc);
  const iw = image.naturalWidth || image.width;
  const ih = image.naturalHeight || image.height;

  // Interpret crop AS-IS (already in natural pixels), then round & clamp to image bounds
  let sx = Math.round(crop.x);
  let sy = Math.round(crop.y);
  let sw = Math.round(crop.width);
  let sh = Math.round(crop.height);

  // Ensure positive width/height
  if (sw < 0) { sx += sw; sw = -sw; }
  if (sh < 0) { sy += sh; sh = -sh; }

  // Clamp to image
  sx = Math.max(0, Math.min(iw - 1, sx));
  sy = Math.max(0, Math.min(ih - 1, sy));
  sw = Math.max(1, Math.min(iw - sx, sw));
  sh = Math.max(1, Math.min(ih - sy, sh));

  // Scale down big crops to avoid huge canvases
  const scale = Math.min(1, maxSize / Math.max(sw, sh));
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  canvas.width = dw;
  canvas.height = dh;

  if (!ctx) throw new Error("2D canvas not available");

  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, dw, dh);
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, dw, dh);

  const blob = await canvasToBlob(canvas, mime, quality);
  if (!blob) throw new Error("Canvas toBlob returned null");
  return blob;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    // crossOrigin is ignored for blob: URLs but harmless for http(s) with CORS
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(new Error("Failed to load image: " + (e?.message || e)));
    img.src = src;
  });
}

function canvasToBlob(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    if (canvas.toBlob) {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Canvas toBlob returned null"))), mime, quality);
      return;
    }
    // Fallback (very old browsers)
    try {
      const dataUrl = canvas.toDataURL(mime, quality);
      const byteString = atob(dataUrl.split(",")[1]);
      const ab = new ArrayBuffer(byteString.length);
      const ia = new Uint8Array(ab);
      for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
      resolve(new Blob([ab], { type: mime }));
    } catch (err) {
      reject(err);
    }
  });
}
