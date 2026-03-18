// UI.jsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Filters, { DEFAULT_FILTERS, getBrand, getCategory } from "./Filters.jsx";
import BoxCropper from "./BoxCropper.jsx";
import getCroppedImg from "./CropImage.jsx";
import { runBatch, searchOneFile, searchTextOnly } from "./ProductSearch.jsx";

import { pickSingleImage } from "./uploads/single_Image_Upload.js";
import { pickFolderImages } from "./uploads/folder_Upload.js";
import { pickPdfToItems } from "./uploads/pdf_Upload.js";
import { exportCartToPdf } from "./exportpdf.jsx";

/* =========================
   Config
========================= */
const API_BASE = "https://product-matcher-production-dc50.up.railway.app";
const SEARCH_URL = `${API_BASE}/search`;

/* =========================
   Tiny Utils
========================= */
const uid = () => Math.random().toString(16).slice(2) + Date.now().toString(16);
const revoke = (u) => {
  try {
    u && URL.revokeObjectURL(u);
  } catch {}
};
const norm = (v) => (v ?? "").toString().trim().replace(/\s+/g, " ");
const normLower = (v) => norm(v).toLowerCase();


/* =========================
   png images
========================= */

function isPngImage(src = "") {
  return /\.png(\?|#|$)/i.test(src) || /format=png/i.test(src);
}

async function flattenImageToWhite(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";

    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth || img.width || 1;
        canvas.height = img.naturalHeight || img.height || 1;

        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("2D canvas not available");

        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);

        canvas.toBlob(
          (blob) => {
            if (!blob) return reject(new Error("Failed to convert canvas to blob"));
            resolve(URL.createObjectURL(blob));
          },
          "image/jpeg",
          0.95
        );
      } catch (err) {
        reject(err);
      }
    };

    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = src;
  });
}
/* =========================
   Result helpers
========================= */
function collapseToBestPerVariant(rows = []) {
  const m = new Map();
  for (const r of rows) {
    const vid = String(r?.variant_id ?? "");
    if (!vid) continue;
    const score = Number(r?.score ?? 0);
    const cur = m.get(vid);
    if (!cur || score > Number(cur.score ?? 0)) m.set(vid, r);
    else if (!cur.image_path && r.image_path) m.set(vid, { ...cur, image_path: r.image_path });
  }
  return [...m.values()].sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0));
}

function bestScoreIndex(rows = []) {
  const m = new Map();
  for (const r of rows) {
    const vid = String(r?.variant_id ?? "");
    if (!vid) continue;
    const s = Number(r?.score ?? 0);
    const cur = m.get(vid);
    if (!cur || s > cur.score) m.set(vid, { row: r, score: s });
  }
  return m;
}

// =====================
// Balanced: 60/40 union merge (normalized)
// =====================
const vidOf = (r) => String(r?.variant_id ?? "");
const scoreOf = (r) => Number(r?.score ?? r?.bestScore ?? 0);

function minMaxNormalize(rows = []) {
  let min = Infinity,
    max = -Infinity;
  for (const r of rows) {
    const s = scoreOf(r);
    if (!Number.isFinite(s)) continue;
    if (s < min) min = s;
    if (s > max) max = s;
  }
  const span = max > min ? max - min : 1;
  return (r) => (scoreOf(r) - min) / span;
}

function bestRowPerVariant(rows = []) {
  const m = new Map();
  for (const r of rows) {
    const vid = vidOf(r);
    if (!vid) continue;
    const s = scoreOf(r);
    const cur = m.get(vid);
    if (!cur || s > cur.s) m.set(vid, { r, s });
  }
  return m;
}

/**
 * Union of variants from BOTH searches.
 * Score = wImg*normImg + wTxt*normTxt
 * If missing in one list, that side contributes 0.
 */
function merge60_40(imageRows = [], textRows = [], { wImg = 0.6, wTxt = 0.4, outN = 50 } = {}) {
  const imgNorm = minMaxNormalize(imageRows);
  const txtNorm = minMaxNormalize(textRows);

  const imgBest = bestRowPerVariant(imageRows);
  const txtBest = bestRowPerVariant(textRows);

  const allVids = new Set([...imgBest.keys(), ...txtBest.keys()]);
  const merged = [];

  for (const vid of allVids) {
    const i = imgBest.get(vid)?.r || null;
    const t = txtBest.get(vid)?.r || null;

    // pick a base row that has image_path if possible
    const base = i?.image_path || i?.images?.[0]?.image_path ? i : t || i;
    if (!base) continue;

    const sImg = i ? imgNorm(i) : 0;
    const sTxt = t ? txtNorm(t) : 0;

    merged.push({
      ...base,
      score: wImg * sImg + wTxt * sTxt,
      _img: sImg,
      _txt: sTxt,
    });
  }

  merged.sort((a, b) => Number(b.score) - Number(a.score));
  return merged.slice(0, outN);
}

/* =========================
   Export helpers
========================= */
function buildSelectedRow(inputItem, variant, option) {
  return {
    key: `${inputItem.id}::${option}::${variant.variant_id}`,
    inputId: inputItem.id,
    inputName: inputItem.sourceName,
    inputPreviewUrl: inputItem.previewUrl,
    option, // "A" | "B" | "C" ...
    chosen: {
      variant_id: variant.variant_id,
      variant_name: variant.variant_name,
      product_url: variant.product_url,
      brand_name: variant.brand_name,
      bestScore: variant.bestScore,
      image_path: variant.images?.[0]?.image_path || "",
    },
  };
}
/* =========================
   Drag & Drop file helpers
========================= */
const isPdfFile = (f) => f?.type === "application/pdf" || /\.pdf$/i.test(f?.name || "");
const isImageFile = (f) => (f?.type || "").startsWith("image/");

function classifyPickedFiles(files) {
  const list = Array.from(files || []);
  const pdf = list.find(isPdfFile);
  const images = list.filter(isImageFile);
  if (pdf) return { kind: "pdf", pdf };
  if (images.length > 1) return { kind: "multiImage", images };
  if (images.length === 1) return { kind: "singleImage", image: images[0] };
  return { kind: "unsupported", files: list };
}

function walkEntry(entry) {
  return new Promise((resolve) => {
    if (!entry) return resolve([]);
    if (entry.isFile) return entry.file((f) => resolve([f]), () => resolve([]));
    if (!entry.isDirectory) return resolve([]);

    const reader = entry.createReader();
    const all = [];
    const read = () =>
      reader.readEntries(
        async (batch) => {
          if (!batch?.length) return resolve(all);
          for (const child of batch) all.push(...(await walkEntry(child)));
          read();
        },
        () => resolve(all)
      );
    read();
  });
}

async function getFilesFromDataTransfer(dt) {
  const items = Array.from(dt?.items || []);
  const entries = items.map((it) => it.webkitGetAsEntry?.()).filter(Boolean);
  if (entries.some((e) => e.isDirectory)) {
    const out = [];
    for (const e of entries) out.push(...(await walkEntry(e)));
    return out;
  }
  return Array.from(dt?.files || []);
}

/* =========================
   Small UI atoms
========================= */
function SegmentedModeToggle({ value, onChange, disabled }) {
  const isScene = value === "scene";
  const btn = (k, label) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(k)}
      className={`px-4 py-2 text-xs font-semibold rounded-full transition ${
        (k === "scene") === isScene ? "bg-black text-white shadow" : "text-gray-700 hover:bg-gray-50"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className={`inline-flex items-center rounded-full border border-gray-200 bg-white shadow-sm p-1 ${disabled ? "opacity-60" : ""}`}>
      {btn("product", "Product")}
      {btn("scene", "Scene")}
    </div>
  );
}
/* =========================
   png
========================= */
function ResultImage({ src, alt, className = "" }) {
  const [displaySrc, setDisplaySrc] = React.useState(src);
  const generatedUrlRef = React.useRef(null);

  React.useEffect(() => {
    let cancelled = false;

    async function prepare() {
      if (generatedUrlRef.current) {
        URL.revokeObjectURL(generatedUrlRef.current);
        generatedUrlRef.current = null;
      }

      if (!src) {
        setDisplaySrc("");
        return;
      }

      if (!isPngImage(src)) {
        setDisplaySrc(src);
        return;
      }

      try {
        const whiteBgUrl = await flattenImageToWhite(src);

        if (cancelled) {
          URL.revokeObjectURL(whiteBgUrl);
          return;
        }

        generatedUrlRef.current = whiteBgUrl;
        setDisplaySrc(whiteBgUrl);
      } catch (e) {
        setDisplaySrc(src);
      }
    }

    prepare();

    return () => {
      cancelled = true;
      if (generatedUrlRef.current) {
        URL.revokeObjectURL(generatedUrlRef.current);
        generatedUrlRef.current = null;
      }
    };
  }, [src]);

  if (!displaySrc) {
    return <div className={className} />;
  }

  return <img src={displaySrc} alt={alt} className={className} loading="lazy" />;
}

/* =========================
   Main Component
========================= */
export default function UI() {
  /* ---- State ---- */
  const [intake, setIntake] = useState(null); // singleImage | multiImage | pdf | null
  const [threshold, setThreshold] = useState(0.25);
  const [searchText, setSearchText] = useState("");
  const [mixMode, setMixMode] = useState("balanced"); // image | balanced | text

  const [items, setItems] = useState([]);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  const [searchMode, setSearchMode] = useState("product"); // product | scene
  const [showCropper, setShowCropper] = useState(false);
  const [sceneBase, setSceneBase] = useState(null);
  const [sceneCroppedFile, setSceneCroppedFile] = useState(null);
  const [sceneCroppedPreview, setSceneCroppedPreview] = useState(null);

  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filters, setFilters] = useState(DEFAULT_FILTERS);

  const [selectedByItemId, setSelectedByItemId] = useState({});
// shape: { [itemId]: variant[] }   // ordered picks => A,B,C...

  // drag polish
  const [dragState, setDragState] = useState("idle"); // idle | accept | reject
  const dragDepthRef = useRef(0);

  // single previews
  const [singlePreviewUrl, setSinglePreviewUrl] = useState(null);

  // refs
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const abortRef = useRef(null);

  /* ---- Toast (minimal) ---- */
  const [toast, setToast] = useState({ show: false, text: "" });
  const toastTimerRef = useRef(null);
  const showToast = useCallback((text) => {
    setToast({ show: true, text });
    clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast({ show: false, text: "" }), 1800);
  }, []);
  useEffect(() => () => clearTimeout(toastTimerRef.current), []);

  /* ---- Derived flags ---- */
  const isBatch = intake === "multiImage" || intake === "pdf";
  const isSingle = intake === "singleImage";
  const isSceneFlow = showCropper || !!sceneCroppedPreview || !!sceneCroppedFile;
  const hasSingleInsideBox = (isSingle && !!singlePreviewUrl) || !!sceneBase?.previewUrl || !!sceneCroppedPreview;
  const showMixToggle = isSingle && !!items?.[0]?.file && !!searchText.trim() && !isSceneFlow;
  const processedCount = useMemo(() => items.filter((x) => x.status === "done" || x.status === "error").length, [items]);

  /* ---- Item helpers ---- */
  const makeItem = useCallback((file, sourceName, sourceType = "image") => {
    return {
      id: uid(),
      sourceType,
      sourceName,
      previewUrl: URL.createObjectURL(file),
      status: "queued",
      topMatches: [],
      allMatches: [],
      rejectedVariantIds: [],
      rawResultsCount: 0,
      errorMessage: "",
      file,
    };
  }, []);

  const cleanupItems = useCallback((arr) => arr?.forEach((it) => revoke(it?.previewUrl)), []);
  useEffect(
    () => () => {
      cleanupItems(items);
      revoke(singlePreviewUrl);
      revoke(sceneBase?.previewUrl);
      revoke(sceneCroppedPreview);
    },
    [] // eslint-disable-line
  );

  /* ---- Clear ---- */
  const clearAll = useCallback(() => {
    abortRef.current?.abort?.();
    abortRef.current = null;

    setLoading(false);
    setMessage("");
    setResults([]);
    setSelectedByItemId({});
    setMixMode("balanced");

    setDragState("idle");
    dragDepthRef.current = 0;

    setItems((prev) => (cleanupItems(prev), []));
    revoke(singlePreviewUrl);
    setSinglePreviewUrl(null);

    revoke(sceneBase?.previewUrl);
    revoke(sceneCroppedPreview);
    setShowCropper(false);
    setSceneBase(null);
    setSceneCroppedFile(null);
    setSceneCroppedPreview(null);

    setFilters(DEFAULT_FILTERS);

    if (fileInputRef.current) fileInputRef.current.value = "";
    if (folderInputRef.current) folderInputRef.current.value = "";
  }, [cleanupItems, singlePreviewUrl, sceneBase, sceneCroppedPreview]);

  /* ---- Filters ---- */
  const filterOptions = useMemo(() => {
    const brands = new Set(),
      categories = new Set();

    for (const r of results || []) {
      const b = norm(getBrand(r));
      const c = norm(getCategory(r));
      if (b) brands.add(b);
      if (c) categories.add(c);
    }

    const sort = (a, b) => a.localeCompare(b);
    return { brands: [...brands].sort(sort), categories: [...categories].sort(sort) };
  }, [results]);

  const filteredResults = useMemo(() => {
    const fb = normLower(filters.brand),
      fc = normLower(filters.category);

    return (results || []).filter((r) => {
      const b = normLower(getBrand(r));
      const c = normLower(getCategory(r));

      if (fb !== "all" && b !== fb) return false;
      if (fc !== "all" && c !== fc) return false;

      return true;
    });
  }, [results, filters]);

  const uniqueFilteredResults = useMemo(() => collapseToBestPerVariant(filteredResults), [filteredResults]);

  /* ---- Option A/B selection (batch) ----
     Cycle behavior: none → A → B → none
  */
  const cycleSelectAB = useCallback((itemId, variant) => {
    setSelectedByItemId((prev) => {
      const cur = prev[itemId] || {};
      const a = cur.A;
      const b = cur.B;

      const isA = a?.variant_id === variant.variant_id;
      const isB = b?.variant_id === variant.variant_id;

      const nextItem = { ...cur };

      if (!isA && !isB) {
        // none -> A (if A empty) else -> B (if A already exists)
        if (!nextItem.A) nextItem.A = variant;
        else nextItem.B = variant;
      } else if (isA) {
        // A -> B
        nextItem.A = undefined;
        nextItem.B = variant;
      } else if (isB) {
        // B -> none
        nextItem.B = undefined;
      }

      const next = { ...prev };
      if (nextItem.A || nextItem.B) next[itemId] = nextItem;
      else delete next[itemId];

      return next;
    });
  }, []);
const MAX_OPTIONS = 26; // A-Z (change to 3 if you only want A/B/C)

const letterForIndex = (i) => String.fromCharCode("A".charCodeAt(0) + i);

const togglePick = useCallback(
  (itemId, variant) => {
    setSelectedByItemId((prev) => {
      const cur = prev[itemId] || [];

      const vid = String(variant.variant_id);
      const idx = cur.findIndex((v) => String(v.variant_id) === vid);

      // If already selected -> remove and compact (B->A, C->B, etc.)
      if (idx >= 0) {
        const nextArr = [...cur.slice(0, idx), ...cur.slice(idx + 1)];
        const next = { ...prev };
        if (nextArr.length) next[itemId] = nextArr;
        else delete next[itemId];
        return next;
      }

      // Not selected -> append if room
      if (cur.length >= MAX_OPTIONS) {
        return prev; // or showToast("Max options reached")
      }

      const nextArr = [...cur, variant];
      return { ...prev, [itemId]: nextArr };
    });
  },
  []
);
  /* ---- Build export rows (A then B per item) ---- */
  const selectedRows = useMemo(() => {
  const rows = [];
  for (const it of items) {
    const picks = selectedByItemId[it.id] || [];
    picks.forEach((variant, i) => {
      rows.push(buildSelectedRow(it, variant, letterForIndex(i)));
    });
  }
  return rows;
}, [items, selectedByItemId]);

const exportSelectedPdf = useCallback(() => {
  if (!selectedRows.length) return showToast("No selections");
  exportCartToPdf(selectedRows);
}, [selectedRows, showToast]);

  /* ---- Batch remove/reject ---- */
  const removeItem = useCallback((id) => {
    setItems((prev) => {
      const t = prev.find((x) => x.id === id);
      revoke(t?.previewUrl);
      return prev.filter((x) => x.id !== id);
    });
    setSelectedByItemId((prev) => {
      if (!prev[id]) return prev;
      const n = { ...prev };
      delete n[id];
      return n;
    });
  }, []);

  const rejectAndReplace = useCallback((itemId, rejectedVariantId) => {
    // Update the item topMatches as you already do
    setItems((prev) =>
      prev.map((it) => {
        if (it.id !== itemId) return it;
        const rejected = new Set(it.rejectedVariantIds || []);
        rejected.add(rejectedVariantId);

        const remainingTop = (it.topMatches || []).filter((v) => v.variant_id !== rejectedVariantId);
        const shown = new Set(remainingTop.map((v) => v.variant_id));
        const replacement = (it.allMatches || []).find((v) => !rejected.has(v.variant_id) && !shown.has(v.variant_id));

        return {
          ...it,
          rejectedVariantIds: [...rejected],
          topMatches: replacement ? [...remainingTop, replacement] : remainingTop,
        };
      })
    );

    // ✅ Also remove that rejected variant from Option A/B if it was selected
    setSelectedByItemId((prev) => {
      const cur = prev[itemId];
      if (!cur) return prev;

      const nextItem = { ...cur };
      if (nextItem.A?.variant_id === rejectedVariantId) nextItem.A = undefined;
      if (nextItem.B?.variant_id === rejectedVariantId) nextItem.B = undefined;

      const next = { ...prev };
      if (nextItem.A || nextItem.B) next[itemId] = nextItem;
      else delete next[itemId];

      return next;
    });
  }, []);

  /* ---- Drag accept ---- */
  const isDragAcceptable = useCallback(
    (e) => {
      if (showCropper) return false;
      const dt = Array.from(e.dataTransfer?.items || []).length ? e.dataTransfer.items : e.dataTransfer.files;
      const arr = Array.from(dt || []);
      if (!arr.length) return true;
      return arr.some((x) => isPdfFile(x) || isImageFile(x) || !x.type);
    },
    [showCropper]
  );

  /* ---- Upload handlers ---- */
  const handlePicked = useCallback(
    async (pickedFiles) => {
      clearAll();
      if (!pickedFiles?.length) return setMessage("No files detected.");

      const cls = classifyPickedFiles(pickedFiles);

      if (cls.kind === "pdf") {
        setIntake("pdf");
        setMessage("Extracting images from PDF…");
        const out = await pickPdfToItems([cls.pdf], { makeItem }).catch((e) => ({
          error: "PDF extraction failed: " + (e?.message || String(e)),
        }));
        if (out.error) return setMessage(out.error);
        setItems(out.items);
        setMessage(out.message);
        return;
      }

      if (cls.kind === "multiImage") {
        setIntake("multiImage");
        const out = pickFolderImages(cls.images, { makeItem });
        setItems(out.items);
        setMessage(out.message);
        return;
      }

      if (cls.kind === "singleImage") {
        setIntake("singleImage");
        const picked = pickSingleImage([cls.image]);
        if (picked.error) return setMessage(picked.error);
        setSinglePreviewUrl(picked.previewUrl);
        setItems([makeItem(picked.file, picked.sourceName, "image")]);
        setResults([]);
        setMessage("Image loaded. Add optional text and click Search.");
        return;
      }

      setIntake(null);
      setMessage("Unsupported drop. Please drop a PDF or image files.");
    },
    [clearAll, makeItem]
  );

  const onFileChange = useCallback(
    async (e) => {
      const picked = Array.from(e.target.files || []);
      e.target.value = "";
      await handlePicked(picked);
    },
    [handlePicked]
  );

  const onFolderChange = useCallback(
    async (e) => {
      const picked = Array.from(e.target.files || []);
      e.target.value = "";
      await handlePicked(picked);
    },
    [handlePicked]
  );

  const onDropFiles = useCallback(
    async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const dropped = await getFilesFromDataTransfer(e.dataTransfer);
      await handlePicked(dropped);
    },
    [handlePicked]
  );

  /* ---- Scene crop confirm ---- */
  const onCropConfirm = useCallback(
    async (pxCrop) => {
      if (!sceneBase?.previewUrl || !sceneBase?.file) return;
      try {
        const blob = await getCroppedImg(sceneBase.previewUrl, pxCrop, {
          mime: sceneBase.file.type || "image/jpeg",
          quality: 0.92,
          maxSize: 2048,
        });
        const cropped = new File([blob], sceneBase.file.name.replace(/\.(\w+)$/i, "-crop.$1"), {
          type: blob.type || sceneBase.file.type || "image/jpeg",
        });
        revoke(sceneCroppedPreview);
        setSceneCroppedFile(cropped);
        setSceneCroppedPreview(URL.createObjectURL(cropped));
        setShowCropper(false);
        setMessage("Crop ready. Click Search.");
      } catch (e) {
        setMessage("Crop failed: " + (e?.message || String(e)));
        setShowCropper(false);
      }
    },
    [sceneBase, sceneCroppedPreview]
  );

  /* ---- Search ---- */
  const cancel = useCallback(() => abortRef.current?.abort?.(), []);

  const runSearch = useCallback(async () => {
    if (loading) return;
    const ac = new AbortController();
    abortRef.current = ac;

    setLoading(true);
    setResults([]);
    setMessage("");

    try {
      const q = searchText.trim();
      const hasText = !!q;
      const productFile = items?.[0]?.file || null;
      const hasImage = !!productFile;

      // Scene (uses backend text too)
      if (sceneCroppedFile) {
        setMessage("Searching (cropped scene)…");
        const out = await searchOneFile({ apiUrl: SEARCH_URL, file: sceneCroppedFile, threshold, text: q, signal: ac.signal });
        setResults(out.raw);
        setMessage(`Found ${out.rawResultsCount} matches.`);
        return;
      }

      // Batch
      if (isBatch) {
        if (!items.length) {
          if (!hasText) return setMessage("Upload something first.");
          setMessage("Searching (text)…");
          const out = await searchTextOnly({ apiUrl: SEARCH_URL, threshold, text: q, signal: ac.signal });
          setResults(out.raw);
          setMessage(`Found ${out.rawResultsCount} matches.`);
          return;
        }

        setItems((prev) => prev.map((it) => ({ ...it, status: "queued", topMatches: [], rawResultsCount: 0, errorMessage: "" })));
        await runBatch({
          apiUrl: SEARCH_URL,
          items: items.map((it) => ({ id: it.id, label: it.sourceName, file: it.file })),
          threshold,
          text: q,
          onUpdate: (id, patch) => setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it))),
          signal: ac.signal,
        });
        setMessage("Done.");
        return;
      }

      // Single
      if (!hasImage && !hasText) return setMessage("Upload an image or type a search query.");

      if (mixMode === "text") {
        if (!hasText) return setMessage("Type something to use Text mode.");
        setMessage("Searching (text)…");
        const out = await searchTextOnly({ apiUrl: SEARCH_URL, threshold, text: q, signal: ac.signal });
        setResults(out.raw);
        setMessage(`Found ${out.rawResultsCount} matches.`);
        return;
      }

      // =====================
      // Balanced (text - image merge)
      // =====================
      if (mixMode === "balanced" && hasImage && hasText) {
        setMessage("Searching (image + text → 60/40 merge)…");

        const [imgOut, txtOut] = await Promise.all([
          searchOneFile({ apiUrl: SEARCH_URL, file: productFile, threshold, text: "", signal: ac.signal }),
          searchTextOnly({ apiUrl: SEARCH_URL, threshold, text: q, signal: ac.signal }),
        ]);

        const merged = merge60_40(imgOut.raw, txtOut.raw, { wImg: 0.6, wTxt: 0.4, outN: 50 });

        setResults(merged);
        setMessage(`Image ${imgOut.rawResultsCount} + Text ${txtOut.rawResultsCount} → showing ${merged.length}`);
        return;
      }

      // image (also used as fallback)
      if (!hasImage) return setMessage("Upload an image to use Image mode.");
      setMessage("Searching (image)…");
      const out = await searchOneFile({ apiUrl: SEARCH_URL, file: productFile, threshold, text: q, signal: ac.signal });
      setResults(out.raw);
      setMessage(`Found ${out.rawResultsCount} matches.`);
    } catch (e) {
      console.error("runSearch error:", e);
      setMessage(e?.name === "AbortError" ? "Cancelled." : "Search failed: " + (e?.message || String(e)));
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  }, [loading, isBatch, items, searchText, threshold, sceneCroppedFile, mixMode]);

  /* =========================
     Render
  ========================= */
  return (
    <div className="bg-white rounded-2xl shadow-lg p-8 relative">
      {/* ---- Toast ---- */}
      {toast.show && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-20 pointer-events-none">
          <div className="bg-black text-white text-sm px-6 py-3 rounded-lg shadow-lg">{toast.text}</div>
        </div>
      )}

      {/* ---- Upload / Drop ---- */}
      <div
        className={`border-2 border-dashed rounded-xl text-center cursor-pointer px-4 py-10 transition-all duration-150 ${
          dragState === "accept"
            ? "border-blue-600 bg-blue-50 ring-4 ring-blue-100"
            : dragState === "reject"
            ? "border-red-400 bg-red-50 ring-4 ring-red-100"
            : "border-gray-300 text-gray-500 hover:bg-gray-50"
        }`}
        onClick={() => !showCropper && fileInputRef.current?.click()}
        onDragEnter={(e) => {
          e.preventDefault();
          e.stopPropagation();
          dragDepthRef.current += 1;
          setDragState(isDragAcceptable(e) ? "accept" : "reject");
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const ok = isDragAcceptable(e);
          e.dataTransfer.dropEffect = ok ? "copy" : "none";
          setDragState(ok ? "accept" : "reject");
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          e.stopPropagation();
          dragDepthRef.current -= 1;
          if (dragDepthRef.current <= 0) (dragDepthRef.current = 0), setDragState("idle");
        }}
        onDrop={async (e) => {
          dragDepthRef.current = 0;
          setDragState("idle");
          await onDropFiles(e);
        }}
      >
        {!hasSingleInsideBox ? (
          <div className="text-sm">
            {dragState === "reject" ? (
              <span className="text-red-700 font-medium">Not supported — drop a PDF or image files</span>
            ) : (
              <span className={dragState === "accept" ? "text-blue-700 font-medium" : ""}>
                {dragState === "accept" ? "Drop a PDF, an image, or a folder of images" : "Drag & drop or click to upload"}
              </span>
            )}
          </div>
        ) : (
          <div className="mt-4 relative w-full h-72 bg-white/40 rounded-lg overflow-hidden">
            {isSingle && singlePreviewUrl && !isSceneFlow && (
              <img src={singlePreviewUrl} alt="uploaded" className="absolute inset-0 w-full h-full object-contain" />
            )}

            {isSceneFlow && sceneBase?.previewUrl && showCropper && (
              <div className="absolute inset-0 bg-black">
                <BoxCropper src={sceneBase.previewUrl} onConfirm={onCropConfirm} onCancel={() => setShowCropper(false)} />
              </div>
            )}

            {isSceneFlow && !showCropper && (sceneCroppedPreview || sceneBase?.previewUrl) && (
              <img src={sceneCroppedPreview || sceneBase.previewUrl} alt="scene" className="absolute inset-0 w-full h-full object-contain" />
            )}

            {loading && (
              <div className="absolute inset-0 bg-white/60 backdrop-blur-[1px] flex items-center justify-center">
                <span className="text-indigo-600 font-semibold">Searching…</span>
              </div>
            )}
          </div>
        )}

        <input ref={fileInputRef} className="hidden" type="file" accept="image/*,application/pdf" multiple onChange={onFileChange} />
        <input
          ref={(el) => {
            folderInputRef.current = el;
            el?.setAttribute("webkitdirectory", "");
            el?.setAttribute("directory", "");
          }}
          className="hidden"
          type="file"
          accept="image/*"
          multiple
          onChange={onFolderChange}
        />
      </div>

      {/* ---- Product / Scene toggle (single) ---- */}
      {intake === "singleImage" && items?.[0]?.file && (
        <>
          <div className="mt-3 flex justify-center">
            <SegmentedModeToggle
              value={searchMode}
              disabled={loading}
              onChange={(next) => {
                if (next === searchMode) return;

                if (next === "product") {
                  setShowCropper(false);
                  setSceneBase(null);
                  setSceneCroppedFile(null);
                  revoke(sceneCroppedPreview);
                  setSceneCroppedPreview(null);
                  setMessage("Product mode. Click Search.");
                  return setSearchMode("product");
                }

                const f = items[0].file;
                if (!f) return;
                setSceneBase({ file: f, previewUrl: singlePreviewUrl });
                setSceneCroppedFile(null);
                revoke(sceneCroppedPreview);
                setSceneCroppedPreview(null);
                setShowCropper(true);
                setSearchMode("scene");
                setMessage("Scene mode: draw a box to crop the region, then confirm.");
              }}
            />
          </div>
          <div className="mt-4 text-xs text-gray-500 flex justify-center">
            Mode: <span className="ml-1 font-semibold text-gray-800">{searchMode === "scene" ? "Scene" : "Product"}</span>
          </div>
        </>
      )}

      {/* ---- Search row ---- */}
      <div className="mt-6 flex gap-3 items-center">
        <div className="relative flex-1">
          <input
            className="w-full px-4 py-3 pr-10 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
            placeholder='e.g. "blue chair"'
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), !loading && runSearch())}
          />

          {searchText && (
            <button
              type="button"
              onClick={() => setSearchText("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 w-6 h-6 flex items-center justify-center rounded-full bg-gray-100 hover:bg-gray-200 text-gray-500 hover:text-gray-800 text-sm"
              title="Clear"
            >
              ×
            </button>
          )}
        </div>

        <button
          onClick={runSearch}
          disabled={loading}
          className={`px-6 py-3 rounded-lg font-semibold text-white bg-indigo-600 hover:bg-indigo-700 ${loading ? "opacity-60 cursor-not-allowed" : ""}`}
        >
          {loading ? `Searching… (${processedCount}/${items.length || 1})` : "Search"}
        </button>

        <button
          type="button"
          onClick={() => setFiltersOpen((v) => !v)}
          className="px-4 py-3 rounded-lg border font-semibold border-gray-300 text-gray-800 hover:bg-gray-50"
        >
          Filters
        </button>
      </div>

      {/* ---- Filters ---- */}
      {filtersOpen && (
        <div className="mt-3">
          <Filters options={filterOptions} filters={filters} onChange={setFilters} onClear={() => setFilters(DEFAULT_FILTERS)} resultsCount={filteredResults.length} />
        </div>
      )}

      {/* ---- Mix toggle (single, image+text) ---- */}
      {showMixToggle && (
        <div className="mt-3 flex justify-center">
          <div className="inline-flex rounded-lg border border-gray-200 bg-white overflow-hidden">
            {[
              ["image", "Image"],
              ["balanced", "Balanced"],
              ["text", "Text"],
            ].map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setMixMode(k)}
                className={`px-3 py-1.5 text-xs font-semibold transition ${mixMode === k ? "bg-indigo-600 text-white" : "text-gray-700 hover:bg-gray-50"}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ---- Threshold + actions ---- */}
      <div className="mt-6">
        <div className="text-sm font-semibold text-gray-800 mb-2">Similarity Threshold: {threshold.toFixed(2)}</div>
        <input type="range" min="0.1" max="0.9" step="0.01" value={threshold} onChange={(e) => setThreshold(+e.target.value)} className="w-full" />

        <div className="mt-4 flex justify-end gap-4">
          {loading && isBatch && (
            <button type="button" onClick={cancel} className="text-sm text-red-600 underline hover:text-red-800">
              Cancel
            </button>
          )}
          <button
            type="button"
            onClick={exportSelectedPdf}
            disabled={loading}
            className={`text-sm underline ${loading ? "text-gray-400 cursor-not-allowed" : "text-gray-600 hover:text-gray-900"}`}
          >
            Export PDF
          </button>
          <button
            type="button"
            onClick={clearAll}
            disabled={loading}
            className={`text-sm underline ${loading ? "text-gray-400 cursor-not-allowed" : "text-gray-600 hover:text-gray-900"}`}
          >
            Clear
          </button>
        </div>

        {isBatch && (
          <div className="mt-4">
            <button
              type="button"
              onClick={runSearch}
              disabled={loading || items.length === 0}
              className={`w-full py-2 rounded-lg font-semibold transition ${
                loading || items.length === 0 ? "bg-gray-300 text-gray-500 cursor-not-allowed" : "bg-black text-white hover:bg-gray-900"
              }`}
            >
              {loading ? "Running Batch…" : "Run Batch"}
            </button>
          </div>
        )}
      </div>

      {/* ---- Batch results ---- */}
      {isBatch && items.length > 0 && (
        <div className="mt-8 space-y-6">
          {items.map((it) => (
            <div key={it.id} className="border border-gray-200 rounded-2xl p-4">
              <div className="flex items-start justify-between gap-6">
                <div className="flex items-start gap-6 flex-1">
                  {/* input thumb */}
                  <div className="group relative w-40 h-40 rounded-xl border-2 border-blue-500 bg-white p-2 overflow-hidden">
                    <div className="absolute inset-x-0 bottom-0 bg-black/70 text-white text-xs px-2 py-1 truncate z-10">
                      {it.sourceName?.includes("•") ? it.sourceName.split("•")[1].trim() : it.sourceName}
                    </div>
                    <button
                      type="button"
                      onClick={(e) => (e.preventDefault(), e.stopPropagation(), removeItem(it.id))}
                      disabled={loading}
                      className={`absolute top-1 right-1 z-20 w-7 h-7 rounded-full text-white text-lg leading-none flex items-center justify-center bg-black/60 ${
                        loading ? "opacity-40 cursor-not-allowed" : "hover:bg-black/80"
                      }`}
                      title={loading ? "Cannot remove while searching" : "Remove"}
                    >
                      ×
                    </button>
                    <img src={it.previewUrl} alt={it.sourceName} className="w-full h-full object-contain" loading="lazy" />
                  </div>

                  {/* matches */}
                  <div className="flex-1">
                    {it.status !== "done" ? (
                      <div className="text-sm text-gray-600">
                        {it.status === "queued" && "Queued"}
                        {it.status === "processing" && "Processing…"}
                        {it.status === "error" && `Error: ${it.errorMessage || "Unknown error"}`}
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                        {it.topMatches?.length ? (
                          it.topMatches.map((variant) => {
                            const picks = selectedByItemId[it.id] || [];
                            const idx = picks.findIndex((v) => String(v.variant_id) === String(variant.variant_id));
                            const selectedLabel = idx >= 0 ? letterForIndex(idx) : null;
                            
                            

                            const img = variant.images?.[0]?.image_path;

                            return (
                              <div key={variant.variant_id} className="flex items-center justify-center">
                                <a href={variant.product_url} target="_blank" rel="noopener noreferrer" className="group block" title={variant.variant_name}>
                                  <div
                                    className={`relative w-40 h-40 rounded-xl border-2 bg-white p-2 overflow-hidden ${
                                      selectedLabel ? "border-green-500 ring-2 ring-green-200" : "border-gray-200 hover:border-gray-300"
                                    }`}
                                  >
                                    {/* A/B badge */}
                                    {selectedLabel && (
                                      <div className="absolute top-2 right-2 z-40 bg-white/85 text-gray-900 text-xs font-bold px-2 py-1 rounded-full">
                                        {selectedLabel}
                                      </div>
                                    )}

                                    <div className="absolute top-2 left-2 right-2 z-30 flex items-center justify-between pointer-events-none">
                                      {/* ✅ select button cycles A/B/none */}
                                      <button
                                        type="button"
                                        onClick={(e) => (e.preventDefault(), e.stopPropagation(), togglePick(it.id, variant))}
                                        className="pointer-events-auto w-6 h-6 rounded-full flex items-center justify-center border border-white/60 bg-white/70 backdrop-blur-sm text-gray-800 shadow-[0_1px_6px_rgba(0,0,0,0.10)] opacity-0 -translate-y-1 group-hover:opacity-100 group-hover:translate-y-0 transition-all duration-150 hover:bg-white active:scale-95"
                                        title="Select (cycles: A → B → none)"
                                      >
                                        <svg viewBox="0 0 20 20" className="w-3.5 h-3.5" fill="currentColor">
                                          <path
                                            fillRule="evenodd"
                                            d="M16.704 5.29a1 1 0 0 1 .006 1.414l-7.2 7.25a1 1 0 0 1-1.42-.004L3.296 9.17a1 1 0 1 1 1.408-1.42l3.09 3.066 6.49-6.527a1 1 0 0 1 1.42.002Z"
                                            clipRule="evenodd"
                                          />
                                        </svg>
                                      </button>

                                      {/* reject */}
                                      <button
                                        type="button"
                                        onClick={(e) => (e.preventDefault(), e.stopPropagation(), rejectAndReplace(it.id, variant.variant_id))}
                                        className="pointer-events-auto w-6 h-6 rounded-full flex items-center justify-center border border-white/60 bg-white/70 backdrop-blur-sm text-gray-800 shadow-[0_1px_6px_rgba(0,0,0,0.10)] opacity-0 -translate-y-1 group-hover:opacity-100 group-hover:translate-y-0 transition-all duration-150 hover:bg-white active:scale-95"
                                        title="Not this one — replace"
                                      >
                                        <svg viewBox="0 0 20 20" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                                          <path d="M6 6L14 14M14 6L6 14" />
                                        </svg>
                                      </button>
                                    </div>

                                    {img ? (
                                            <ResultImage
                                              src={img}
                                              alt={variant.variant_name}
                                              className="w-full h-full object-contain"
                                            />
                                          ) : (
                                            <div className="w-full h-full bg-gray-50" />
                                          )}

                                    <div className="absolute inset-x-0 bottom-0 bg-black/70 text-white text-xs px-2 py-1 opacity-0 group-hover:opacity-100 transition-opacity rounded-b-xl">
                                      <div className="font-semibold leading-tight truncate">{variant.variant_name}</div>
                                      <div className="leading-tight opacity-90 truncate">{variant.brand_name || "Unknown brand"}</div>
                                      <div className="leading-tight opacity-90">{(((variant.bestScore ?? 0) * 100).toFixed(1))}% match</div>
                                    </div>
                                  </div>
                                </a>
                              </div>
                            );
                          })
                        ) : (
                          <div className="text-sm text-gray-600">No results above threshold.</div>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                <div className="text-xs whitespace-nowrap pt-2">
                  {it.status === "done" && <span className="text-green-700 font-medium">Done</span>}
                  {it.status === "processing" && <span className="text-indigo-700">Processing…</span>}
                  {it.status === "queued" && <span className="text-gray-500">Queued</span>}
                  {it.status === "error" && <span className="text-red-700">Error</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ---- Single results cards ---- */}
      {!isBatch && uniqueFilteredResults.length > 0 && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6 mt-8">
            {uniqueFilteredResults.slice(0, 20).map((item, i) => (
              <div key={`${item.variant_id}-${item.image_id}-${i}`} className="p-4 border border-gray-200 rounded-xl shadow-md bg-white">
                <a
                  href={item.product_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block text-indigo-700 font-semibold text-base underline truncate hover:text-indigo-900"
                >
                  {item.variant_name}
                </a>
                <div className="text-sm text-gray-600 truncate">{item.brand_name}</div>
                <div className="mt-2 text-sm font-medium text-indigo-700">Match: {((item.score ?? 0) * 100).toFixed(1)}%</div>
                <ResultImage
                    src={item.image_path}
                    alt={item.variant_name}
                    className="w-full h-36 object-contain rounded-md mt-3 bg-white border"
                  />
              </div>
            ))}
          </div>
          <div className="mt-6 text-sm text-gray-700 text-center">
            {results.length} matches → {uniqueFilteredResults.length} unique products
          </div>
        </>
      )}
    </div>
  );
}