import React, { useState, useRef, useEffect } from "react";

/**
 * BoxCropper — draw/move/resize a rectangle over a fitted image
 * Props:
 *  - src: string (image url / object url)
 *  - onConfirm(px): function({x,y,width,height} in ORIGINAL IMAGE PIXELS)
 *  - onCancel(): function()
 */
function BoxCropper({ src, onConfirm, onCancel }) {
  const containerRef = useRef(null);

  const [img, setImg] = useState(null); // HTMLImageElement with naturalWidth/Height
  const [box, setBox] = useState(null); // {x,y,w,h} in DISPLAY px (relative to container)
  const [mode, setMode] = useState("idle"); // idle | drawing | moving | resizing
  const [activeHandle, setActiveHandle] = useState(null); // 'n','s','e','w','nw','ne','sw','se'
  const startRef = useRef(null); // {x,y, box}
  const boxRef = useRef(null); // keep latest box for stable key handler

  const MIN = 20; // minimum selection size in px
  const HANDLE = 8; // handle visual size

  // Load image
  useEffect(() => {
    const i = new Image();
    i.crossOrigin = "anonymous"; // safe for blob: too
    i.onload = () => setImg(i);
    i.onerror = () => setImg(null);
    i.src = src;

    // cleanup: revoke object URLs to avoid leaks
    return () => {
      if (typeof src === "string" && src.startsWith("blob:")) {
        try { URL.revokeObjectURL(src); } catch {}
      }
    };
  }, [src]);

  // keep ref in sync
  useEffect(() => { boxRef.current = box; }, [box]);

  // Keyboard shortcuts: Enter confirm, Esc cancel (mounted once; reads refs)
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Enter") {
        const b = boxRef.current;
        if (b) {
          const px = toImagePixels(b);
          if (px && px.width >= 2 && px.height >= 2) onConfirm?.(px);
        }
      }
      if (e.key === "Escape") onCancel?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const pointer = (e) => (e.touches ? e.touches[0] : e);

  function fitContain(iw, ih, cw, ch) {
    const r = Math.min(cw / iw, ch / ih);
    const dw = Math.round(iw * r);
    const dh = Math.round(ih * r);
    const ox = Math.round((cw - dw) / 2);
    const oy = Math.round((ch - dh) / 2);
    return { dw, dh, ox, oy };
  }

  function getBounds() {
    if (!containerRef.current || !img) return null;
    const rect = containerRef.current.getBoundingClientRect();
    const { dw, dh, ox, oy } = fitContain(img.naturalWidth, img.naturalHeight, rect.width, rect.height);
    return { rect, dw, dh, ox, oy };
  }

  function normalize(b) {
    let { x, y, w, h } = b;
    if (w < 0) { x += w; w = -w; }
    if (h < 0) { y += h; h = -h; }
    return { x, y, w, h };
  }

  function clampBoxToImage(b) {
    const bounds = getBounds();
    if (!bounds) return b;
    const { dw, dh, ox, oy } = bounds;
    const maxX = ox + dw;
    const maxY = oy + dh;
    let x = Math.max(ox, Math.min(b.x, maxX - MIN));
    let y = Math.max(oy, Math.min(b.y, maxY - MIN));
    let w = Math.max(MIN, Math.min(b.w, maxX - x));
    let h = Math.max(MIN, Math.min(b.h, maxY - y));
    return { x, y, w, h };
  }

function toImagePixels(b) {
  // Convert selection box (CSS px) -> original image pixels
  const bounds = getBounds();
  if (!bounds) return null;
  const { dw, dh, ox, oy } = bounds;

  // Selection relative to fitted image (CSS px)
  const sxCSS = Math.max(0, Math.min(b.x - ox, dw));
  const syCSS = Math.max(0, Math.min(b.y - oy, dh));
  const swCSS = Math.max(1, Math.min(b.w, dw - sxCSS));
  const shCSS = Math.max(1, Math.min(b.h, dh - syCSS));

  // Scale to natural pixels
  const scaleX = img.naturalWidth / dw;
  const scaleY = img.naturalHeight / dh;

  return {
    x: Math.round(sxCSS * scaleX),
    y: Math.round(syCSS * scaleY),
    width: Math.round(swCSS * scaleX),
    height: Math.round(shCSS * scaleY),
  };
}

  // ===== Pointer logic =====
  const onCanvasDown = (e) => {
    e.preventDefault();
    const p = pointer(e);
    const b = getBounds();
    if (!b) return;
    const { rect } = b;
    const x = p.clientX - rect.left;
    const y = p.clientY - rect.top;
    setBox({ x, y, w: 0, h: 0 });
    startRef.current = { x, y, box: null };
    setMode("drawing");
  };

  const onRectDown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!box) return;
    const p = pointer(e);
    startRef.current = { x: p.clientX, y: p.clientY, box: { ...box } };
    setMode("moving");
  };

  const onHandleDown = (handle) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!box) return;
    const p = pointer(e);
    startRef.current = { x: p.clientX, y: p.clientY, box: { ...box } };
    setActiveHandle(handle);
    setMode("resizing");
  };

  const onMove = (e) => {
    if (mode === "idle") return;
    const p = pointer(e);

    if (mode === "drawing") {
      const s = startRef.current;
      const b = getBounds();
      if (!b) return;
      const { rect } = b;
      const cx = p.clientX - rect.left;
      const cy = p.clientY - rect.top;
      const raw = normalize({ x: s.x, y: s.y, w: cx - s.x, h: cy - s.y });
      setBox(clampBoxToImage(raw));
      return;
    }

    if (mode === "moving") {
      const s = startRef.current;
      const dx = p.clientX - s.x;
      const dy = p.clientY - s.y;
      const moved = { x: s.box.x + dx, y: s.box.y + dy, w: s.box.w, h: s.box.h };
      setBox(clampBoxToImage(moved));
      return;
    }

    if (mode === "resizing") {
      const s = startRef.current;
      const dx = p.clientX - s.x;
      const dy = p.clientY - s.y;
      let { x, y, w, h } = s.box;

      if (activeHandle.includes("e")) w = s.box.w + dx;
      if (activeHandle.includes("s")) h = s.box.h + dy;
      if (activeHandle.includes("w")) { x = s.box.x + dx; w = s.box.w - dx; }
      if (activeHandle.includes("n")) { y = s.box.y + dy; h = s.box.h - dy; }

      // Shift = keep aspect ratio
      if (e.shiftKey) {
        const ratio = s.box.w / s.box.h || 1;
        if (Math.abs(w / h - ratio) > 0.0001) {
          if (Math.abs(dx) > Math.abs(dy)) h = w / ratio; else w = h * ratio;
        }
      }

      const raw = normalize({ x, y, w, h });
      setBox(clampBoxToImage(raw));
      return;
    }
  };

  const onUp = () => {
    if (mode !== "idle") {
      setMode("idle");
      setActiveHandle(null);
    }
  };

  // ===== Confirm mapping =====
  const handleConfirm = () => {
    const b = boxRef.current || box;
    if (!b) return onCancel?.();
    const px = toImagePixels(b);
    if (!px || px.width < 2 || px.height < 2) return onCancel?.();
    onConfirm?.(px);
  };

  // ===== Render =====
  const handleSpec = [
    ["nw", 0, 0, "nwse-resize"],
    ["n", 50, 0, "ns-resize"],
    ["ne", 100, 0, "nesw-resize"],
    ["e", 100, 50, "ew-resize"],
    ["se", 100, 100, "nwse-resize"],
    ["s", 50, 100, "ns-resize"],
    ["sw", 0, 100, "nesw-resize"],
    ["w", 0, 50, "ew-resize"],
  ];

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 select-none touch-none cursor-crosshair"
      onMouseDown={onCanvasDown}
      onMouseMove={onMove}
      onMouseUp={onUp}
      onMouseLeave={onUp}
      onTouchStart={onCanvasDown}
      onTouchMove={onMove}
      onTouchEnd={onUp}
    >
      {/* fitted image */}
      {img && (
        <img
          src={src}
          alt="crop"
          className="absolute"
          style={imageFitStyle(img, containerRef)}
        />
      )}

      {/* dim mask */}
      <div className="absolute inset-0 bg-black/30 pointer-events-none" />

      {/* selection + handles */}
      {box && (
        <div
          className="absolute border-2 border-indigo-500 bg-indigo-500/10"
          style={{ left: box.x, top: box.y, width: box.w, height: box.h, cursor: "move" }}
          onMouseDown={onRectDown}
          onTouchStart={onRectDown}
        >
          {handleSpec.map(([key, px, py, cursor]) => (
            <div
              key={key}
              onMouseDown={onHandleDown(key)}
              onTouchStart={onHandleDown(key)}
              className="absolute bg-white border-2 border-indigo-500 rounded"
              style={{
                width: HANDLE,
                height: HANDLE,
                left: `calc(${px}% )`,
                top: `calc(${py}% )`,
                transform: "translate(-50%, -50%)",
                cursor,
              }}
            />
          ))}
        </div>
      )}

      {/* controls */}
      <div
        className="absolute bottom-4 left-4 right-4 flex items-center justify-end space-x-3"
        onMouseDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
      >
        <button
          onClick={handleConfirm}
          className="bg-indigo-600 text-white px-5 py-2 rounded-lg shadow hover:bg-indigo-700"
        >
          ✅ Use This Crop
        </button>
        <button
          onClick={onCancel}
          className="bg-gray-500 text-white px-5 py-2 rounded-lg shadow hover:bg-gray-600"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function imageFitStyle(img, ref) {
  if (!ref.current) return {};
  const rect = ref.current.getBoundingClientRect();
  const r = Math.min(rect.width / img.naturalWidth, rect.height / img.naturalHeight);
  const dw = Math.round(img.naturalWidth * r);
  const dh = Math.round(img.naturalHeight * r);
  const ox = Math.round((rect.width - dw) / 2);
  const oy = Math.round((rect.height - dh) / 2);
  return { width: `${dw}px`, height: `${dh}px`, left: `${ox}px`, top: `${oy}px` };
}

export default BoxCropper;
