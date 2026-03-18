#!/usr/bin/env python3
"""
Dynamic schedule PDF image extractor (template-agnostic-ish)

Goal:
- Export ONLY the product images that live in the "image column" (wherever it is).
- Name each exported image as the product code (e.g., LF02, SE14A, etc.).
- Use PyMuPDF for embedded image extraction (highest fidelity).
- If a row has no embedded raster image, render only that row's image-cell as fallback.
- **FIX: Correctly handle image rotation using transformation matrices**

Requirements:
- pip install pymupdf
- pip install pillow (for rotation handling)

Usage:
  python extract_dynamic.py input.pdf --out out_images
  python extract_dynamic.py input.pdf --out out_images --dpi 400
  python extract_dynamic.py input.pdf --out out_images --no-render-fallback
"""

from __future__ import annotations
import argparse
import re
from dataclasses import dataclass
from pathlib import Path
from typing import List, Tuple, Dict, Optional
import fitz  # PyMuPDF
from PIL import Image
import io
import math


# ---------- Tunables ----------
# Code patterns: supports LF02, LR01, SE14a, AB123, etc.
CODE_RE = re.compile(r"^[A-Z]{1,5}\d{1,5}[A-Z]?$", re.IGNORECASE)

# Column clustering sensitivity (PDF points). If columns merge/split, adjust.
COLUMN_X_TOL = 18.0

# Skip tiny embedded images (icons)
MIN_EMBED_W = 80
MIN_EMBED_H = 80

# Render fallback DPI (for vector-only / non-embedded visuals)
DEFAULT_DPI = 350

# Expand detected column ranges so we don't miss slightly wider images
COLUMN_PAD = 12.0
# ----------------------------


@dataclass
class Word:
    x0: float
    y0: float
    x1: float
    y1: float
    text: str

    @property
    def cx(self) -> float:
        return 0.5 * (self.x0 + self.x1)

    @property
    def cy(self) -> float:
        return 0.5 * (self.y0 + self.y1)


@dataclass
class Column:
    x0: float
    x1: float
    words: List[Word]

    @property
    def width(self) -> float:
        return self.x1 - self.x0

    @property
    def cx(self) -> float:
        return 0.5 * (self.x0 + self.x1)


def normalize_code(s: str) -> str:
    # Normalize spaces/dashes and uppercase; keep only alnum
    s = (s or "").strip()
    s = re.sub(r"[\s\-_/]+", "", s)
    return s.upper()


def is_code_token(s: str) -> bool:
    s2 = normalize_code(s)
    return bool(CODE_RE.match(s2))


def get_words_pymupdf(page: fitz.Page) -> List[Word]:
    # page.get_text("words") -> [x0,y0,x1,y1,"word", block, line, word_no]
    raw = page.get_text("words") or []
    words = []
    for w in raw:
        if len(w) < 5:
            continue
        x0, y0, x1, y1, t = w[:5]
        t = (t or "").strip()
        if not t:
            continue
        words.append(Word(x0, y0, x1, y1, t))
    return words


def cluster_columns(words: List[Word], x_tol: float) -> List[Column]:
    """
    Simple 1D clustering by x-center:
    - Sort by cx
    - Greedily group into columns if within tolerance of current column center band
    """
    if not words:
        return []
    words_sorted = sorted(words, key=lambda w: w.cx)
    cols: List[List[Word]] = []

    for w in words_sorted:
        placed = False
        for bucket in cols:
            # Compare to bucket median cx
            cxs = [bw.cx for bw in bucket]
            med = sorted(cxs)[len(cxs) // 2]
            if abs(w.cx - med) <= x_tol:
                bucket.append(w)
                placed = True
                break
        if not placed:
            cols.append([w])

    out_cols: List[Column] = []
    for bucket in cols:
        x0 = min(w.x0 for w in bucket) - COLUMN_PAD
        x1 = max(w.x1 for w in bucket) + COLUMN_PAD
        out_cols.append(Column(x0=x0, x1=x1, words=bucket))

    # Merge overlapping columns (rare but helps)
    out_cols.sort(key=lambda c: c.x0)
    merged: List[Column] = []
    for c in out_cols:
        if not merged:
            merged.append(c)
            continue
        prev = merged[-1]
        if c.x0 <= prev.x1:  # overlap
            merged[-1] = Column(
                x0=min(prev.x0, c.x0),
                x1=max(prev.x1, c.x1),
                words=prev.words + c.words,
            )
        else:
            merged.append(c)

    return merged


def choose_code_column(columns: List[Column]) -> Optional[Column]:
    """
    Code column is the one with most code-like tokens.
    """
    best = None
    best_score = 0
    for col in columns:
        score = sum(1 for w in col.words if is_code_token(w.text))
        if score > best_score:
            best_score = score
            best = col
    return best if best_score > 0 else None


def image_rects_with_xref(page: fitz.Page) -> List[Tuple[int, fitz.Rect]]:
    out: List[Tuple[int, fitz.Rect]] = []
    for img in page.get_images(full=True) or []:
        xref = img[0]
        rects = page.get_image_rects(xref) or []
        for r in rects:
            out.append((xref, r))
    return out


def choose_image_column(columns: List[Column], img_rects: List[Tuple[int, fitz.Rect]]) -> Optional[Column]:
    """
    Image column is the column whose x-range overlaps the most with actual image rectangles
    (by area or count). We use overlap area sum as score.
    """
    if not columns or not img_rects:
        return None

    best = None
    best_score = 0.0
    for col in columns:
        col_rect = fitz.Rect(col.x0, -1e9, col.x1, 1e9)
        score = 0.0
        for _, r in img_rects:
            inter = r & col_rect
            if not inter.is_empty:
                score += inter.width * inter.height
        if score > best_score:
            best_score = score
            best = col

    return best if best_score > 0 else None


def extract_codes_in_column(words: List[Word], code_col: Column) -> List[Tuple[str, fitz.Rect]]:
    """
    Return unique codes (top-to-bottom) found within the detected code column.
    """
    in_col = [w for w in words if (w.cx >= code_col.x0 and w.cx <= code_col.x1)]
    candidates: List[Tuple[str, fitz.Rect]] = []
    for w in in_col:
        if is_code_token(w.text):
            code = normalize_code(w.text)
            bbox = fitz.Rect(w.x0, w.y0, w.x1, w.y1)
            candidates.append((code, bbox))

    # Deduplicate codes: keep the top-most occurrence per code
    best: Dict[str, fitz.Rect] = {}
    for code, bbox in candidates:
        if code not in best or bbox.y0 < best[code].y0:
            best[code] = bbox

    out = [(c, best[c]) for c in best.keys()]
    out.sort(key=lambda x: x[1].y0)
    return out


def build_row_bands(codes: List[Tuple[str, fitz.Rect]], page_rect: fitz.Rect) -> List[Tuple[str, float, float]]:
    """
    Create (code, y0, y1) row bands using midpoints between code centers.
    Improvement: first row band starts above the first code by half the first row spacing
    (instead of at the top of the page), which prevents header/logo leakage.
    """
    centers = [(code, 0.5 * (bbox.y0 + bbox.y1), bbox) for code, bbox in codes]
    rows = []

    n = len(centers)
    for i, (code, cy, bbox) in enumerate(centers):
        if i == 0:
            if n >= 2:
                next_cy = centers[i + 1][1]
                half_gap = 0.5 * (next_cy - cy)
                y0 = max(page_rect.y0, cy - half_gap)
            else:
                # Only one code on page: start a bit above its bbox
                y0 = max(page_rect.y0, bbox.y0 - 20.0)
        else:
            prev_cy = centers[i - 1][1]
            y0 = 0.5 * (prev_cy + cy)

        if i == n - 1:
            y1 = page_rect.y1
        else:
            next_cy = centers[i + 1][1]
            y1 = 0.5 * (cy + next_cy)

        rows.append((code, y0, y1))

    return rows


def overlap_area(a: fitz.Rect, b: fitz.Rect) -> float:
    inter = a & b
    if inter.is_empty:
        return 0.0
    return inter.width * inter.height


def get_image_transform(page: fitz.Page, xref: int) -> Optional[fitz.Matrix]:
    """
    Get the transformation matrix for an image on the page.
    Returns the matrix if found, None otherwise.
    """
    try:
        # Get the page's contents and look for the image transformation
        # This is more reliable than aspect ratio heuristics
        img_info = page.get_image_info(xrefs=True)
        for info in img_info:
            if info['xref'] == xref:
                # Get the transformation matrix
                transform = info.get('transform')
                if transform:
                    return fitz.Matrix(*transform)
    except Exception as e:
        print(f"Warning: Could not get transform for xref {xref}: {e}")
    return None


def get_rotation_from_matrix(matrix: fitz.Matrix) -> int:
    """
    Extract rotation angle from a transformation matrix.
    Returns rotation in degrees (0, 90, 180, 270).
    """
    if matrix is None:
        return 0
    
    # Extract the rotation angle from the matrix
    # The matrix is: [a, b, c, d, e, f]
    # where the rotation is encoded in a, b, c, d
    a, b, c, d = matrix.a, matrix.b, matrix.c, matrix.d
    
    # Calculate angle in radians then convert to degrees
    angle_rad = math.atan2(b, a)
    angle_deg = math.degrees(angle_rad)
    
    # Normalize to 0, 90, 180, 270
    angle_deg = round(angle_deg / 90) * 90
    angle_deg = angle_deg % 360
    
    # Also check for negative scaling which indicates a flip
    if d < 0:
        # Vertical flip - treat as 180 degree rotation
        angle_deg = (angle_deg + 180) % 360
    
    return int(angle_deg)


def rotate_image_if_needed(img_bytes: bytes, rotation: int) -> bytes:
    """
    Rotate image bytes by the specified angle.
    Converts CMYK to RGB if necessary.
    """
    if rotation == 0:
        return img_bytes
    
    try:
        img = Image.open(io.BytesIO(img_bytes))
        
        # Convert CMYK to RGB (PNG doesn't support CMYK)
        if img.mode == 'CMYK':
            img = img.convert('RGB')
        
        # PIL rotation is counter-clockwise
        # PDF rotation is typically clockwise, so negate
        if rotation == 90:
            img = img.rotate(-90, expand=True)
        elif rotation == 180:
            img = img.rotate(-180, expand=True)
        elif rotation == 270:
            img = img.rotate(-270, expand=True)
        
        # Save back to bytes as PNG
        output = io.BytesIO()
        img.save(output, format='PNG')
        return output.getvalue()
    except Exception as e:
        print(f"Warning: Could not rotate image: {e}")
        return img_bytes


def render_cell(page: fitz.Page, rect: fitz.Rect, dpi: int) -> bytes:
    zoom = dpi / 72.0
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), clip=rect, alpha=False)
    return pix.tobytes("png")


def cell_has_meaningful_content(page: fitz.Page, rect: fitz.Rect) -> bool:
    """
    Check if a cell area has meaningful image content (not just white space or text).
    Returns True if there's likely an image, False if it's empty or text-only.
    """
    # Check if there's any text in this region
    text = page.get_text("text", clip=rect).strip()
    if text:
        # If there's text, it's probably not an image cell
        return False
    
    # Check for vector graphics (paths/drawings) in this area
    # If there are drawings but no embedded images, it might be a vector illustration
    drawings = page.get_drawings()
    has_drawings = False
    for drawing in drawings:
        draw_rect = drawing.get("rect")
        if draw_rect and overlap_area(fitz.Rect(draw_rect), rect) > 0:
            has_drawings = True
            break
    
    # If there are drawings and no text, it's probably vector art worth rendering
    if has_drawings:
        return True
    
    # Otherwise, it's likely empty
    return False


def write_unique(path: Path, data: bytes) -> None:
    if not path.exists():
        path.write_bytes(data)
        return
    stem, ext = path.stem, path.suffix
    k = 2
    while True:
        p2 = path.with_name(f"{stem}_{k}{ext}")
        if not p2.exists():
            p2.write_bytes(data)
            return
        k += 1

def code_suffix(n: int) -> str:
    # 0->A, 1->B, ... 25->Z, 26->AA ...
    letters = ""
    n += 1
    while n:
        n, r = divmod(n - 1, 26)
        letters = chr(ord("A") + r) + letters
    return letters


def extract_dynamic(pdf_path: Path, out_dir: Path, dpi: int, render_fallback: bool) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    doc = fitz.open(pdf_path)

    for pi in range(doc.page_count):
        page = doc.load_page(pi)
        page_rect = page.rect

        # 1) words + columns
        words = get_words_pymupdf(page)
        if not words:
            continue
        columns = cluster_columns(words, COLUMN_X_TOL)
        if not columns:
            continue

        # 2) detect code column
        code_col = choose_code_column(columns)
        if not code_col:
            continue

        # 3) detect image column via actual image rectangles
        img_rects = image_rects_with_xref(page)
        image_col = choose_image_column(columns, img_rects)
        if not image_col:
            # If there are no embedded images at all, we can't "prove" an image column.
            # In that case, we still proceed: use the widest non-code column as a guess,
            # but ONLY if render_fallback is enabled.
            if not render_fallback:
                continue
            non_code_cols = [c for c in columns if c is not code_col]
            if not non_code_cols:
                continue
            image_col = max(non_code_cols, key=lambda c: c.width)

        # 4) extract codes and rows
        codes = extract_codes_in_column(words, code_col)
        if not codes:
            continue

        rows = build_row_bands(codes, page_rect)
        if not rows:
            continue

        table_top = rows[0][1]  # y0 of first row band


    
        # 5) For each row/code, collect ALL embedded images within image_col and within row band
        all_for_code: Dict[str, List[Tuple[float, int, fitz.Rect]]] = {code: [] for code, _, _ in rows}
        col_rect = fitz.Rect(image_col.x0, page_rect.y0, image_col.x1, page_rect.y1)

        for xref, r in img_rects:
            # must overlap image column
            if overlap_area(r, col_rect) <= 0:
                continue

            cy = 0.5 * (r.y0 + r.y1)
            for code, y0, y1 in rows:
                if y0 <= cy <= y1:
                    row_rect = fitz.Rect(image_col.x0, y0, image_col.x1, y1)
                    score = overlap_area(r, row_rect)
                    if score > 0:
                        all_for_code[code].append((score, xref, r))
                    break

        # De-duplicate within a row (same xref can appear multiple times / multiple rects)
        for code in list(all_for_code.keys()):
            best_by_xref: Dict[int, Tuple[float, int, fitz.Rect]] = {}
            for score, xref, r in all_for_code[code]:
                cur = best_by_xref.get(xref)
                if cur is None or score > cur[0]:
                    best_by_xref[xref] = (score, xref, r)
            # Sort: most important first (usually the photo is bigger than the line drawing)
            all_for_code[code] = sorted(best_by_xref.values(), key=lambda t: t[0], reverse=True)

        # 6) Export: embedded-first (ALL in cell), else render fallback per-row
        for code, y0, y1 in rows:
            candidates = all_for_code.get(code, [])

            # Filter to "valid" embedded images (non-tiny) first
            valid = []
            for (_score, xref, _r) in candidates:
                try:
                    info = doc.extract_image(xref)
                    w = int(info.get("width") or 0)
                    h = int(info.get("height") or 0)
                    if w >= MIN_EMBED_W and h >= MIN_EMBED_H:
                        valid.append(xref)
                except Exception:
                    continue

            # De-dupe xrefs (just in case)
            valid_unique = []
            seen_x = set()
            for x in valid:
                if x not in seen_x:
                    seen_x.add(x)
                    valid_unique.append(x)

            exported_any = False

            if len(valid_unique) == 1:
                # Exactly one image -> NO suffix
                xref = valid_unique[0]
                info = doc.extract_image(xref)
                img_bytes = info["image"]
                
                # **FIX: Get rotation from transformation matrix**
                transform = get_image_transform(page, xref)
                rotation = get_rotation_from_matrix(transform)
                
                if rotation != 0:
                    print(f"Rotating {code} by {rotation} degrees")
                    img_bytes = rotate_image_if_needed(img_bytes, rotation)
                
                ext = (info.get("ext") or "png").lower()
                if ext == "jpeg":
                    ext = "jpg"
                # Force PNG if we rotated (since we used PIL)
                if rotation != 0:
                    ext = "png"
                    
                out_path = out_dir / f"{code}.{ext}"
                write_unique(out_path, img_bytes)
                exported_any = True

            elif len(valid_unique) >= 2:
                # Two or more -> use A, B, C...
                for idx, xref in enumerate(valid_unique):
                    info = doc.extract_image(xref)
                    img_bytes = info["image"]
                    
                    # **FIX: Get rotation from transformation matrix**
                    transform = get_image_transform(page, xref)
                    rotation = get_rotation_from_matrix(transform)
                    
                    if rotation != 0:
                        print(f"Rotating {code} (image {idx+1}) by {rotation} degrees")
                        img_bytes = rotate_image_if_needed(img_bytes, rotation)
                    
                    ext = (info.get("ext") or "png").lower()
                    if ext == "jpeg":
                        ext = "jpg"
                    # Force PNG if we rotated
                    if rotation != 0:
                        ext = "png"

                    suf = code_suffix(idx)  # A, B, C...
                    out_path = out_dir / f"{code}{suf}.{ext}"
                    write_unique(out_path, img_bytes)
                exported_any = True

            # If nothing embedded was exportable, fallback render for the whole image cell
            if (not exported_any) and render_fallback:
                cell = fitz.Rect(image_col.x0, y0, image_col.x1, y1)
                
                # Check if the cell actually has meaningful visual content
                if cell_has_meaningful_content(page, cell):
                    png = render_cell(page, cell, dpi)
                    out_path = out_dir / f"{code}.png"   # NO suffix on fallback single render
                    write_unique(out_path, png)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf", help="Input PDF path")
    ap.add_argument("--out", default="out_images", help="Output folder")
    ap.add_argument("--dpi", type=int, default=DEFAULT_DPI, help="Render fallback DPI")
    ap.add_argument("--no-render-fallback", action="store_true", help="Disable per-row rendering fallback")
    args = ap.parse_args()

    pdf_path = Path(args.pdf)
    out_dir = Path(args.out) / pdf_path.stem
    extract_dynamic(pdf_path, out_dir, dpi=args.dpi, render_fallback=(not args.no_render_fallback))


if __name__ == "__main__":
    main()