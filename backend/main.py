import os, io, time
from typing import Optional

import re
import meilisearch

from dotenv import load_dotenv
from fastapi import FastAPI, File, UploadFile, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from supabase import create_client
import json

import torch, clip
import numpy as np
from PIL import Image as PILImage

# --------------------------
# Env & Clients
# --------------------------
load_dotenv()
SUPABASE_URL="https://rffqzfdzosambdxmpuac.supabase.co/"
SUPABASE_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmZnF6ZmR6b3NhbWJkeG1wdWFjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTU2NjU1MTYsImV4cCI6MjA3MTI0MTUxNn0.bNj0M4SwVT0SVRVCFarBJLtBS-nYrSM7ZsZ_nGsMR5U"
#SUPABASE_URL = os.getenv("SUPABASE_URL")
#SUPABASE_KEY = os.getenv("SUPABASE_KEY")
if not SUPABASE_URL or not SUPABASE_KEY:
    raise RuntimeError("Missing SUPABASE_URL or SUPABASE_ANON_KEY in env")

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

MEILI_URL = os.getenv("MEILI_URL")
MEILI_MASTER_KEY = os.getenv("MEILI_MASTER_KEY")

meili_client = None
meili_index = None

if MEILI_URL and MEILI_MASTER_KEY:
    meili_client = meilisearch.Client(MEILI_URL, MEILI_MASTER_KEY)
    meili_index = meili_client.index("products")

# --------------------------
# Model (CLIP ViT-B/32)
# --------------------------
device = "cuda" if torch.cuda.is_available() else "cpu"
model = None
preprocess = None

def get_clip():
    global model, preprocess
    if model is None or preprocess is None:
        model, preprocess = clip.load("ViT-B/32", device=device)
    return model, preprocess


# Adding Meilisearch helpers
STOP_WORDS = {
    "how", "many", "do", "i", "have", "what", "which",
    "where", "are", "the", "is", "there", "enough"
}

TERM_NORMALIZATION = {
    "chairs": "chair",
    "desks": "desk",
    "tables": "table",
    "sofas": "sofa",
    "stools": "stool",
    "benches": "bench",
    "pedrali's": "pedrali",
    "arper's": "arper",
}

def normalize_text(text: str) -> str:
    text = text.lower()
    text = re.sub(r"[^a-z0-9\s]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text

def normalize_query(raw_query: str) -> str:
    text = normalize_text(raw_query)
    tokens = text.split()

    cleaned = []
    for token in tokens:
        token = TERM_NORMALIZATION.get(token, token)
        if token not in STOP_WORDS:
            cleaned.append(token)

    return " ".join(cleaned).strip()

def build_meili_filter(conditions: list | None, active_only: bool = True) -> str | None:
    filters = []

    if active_only:
        filters.append("active = true")

    for cond in conditions or []:
        field = cond.get("field")
        operator = cond.get("operator")
        value = (cond.get("value") or "").strip().replace('"', '\\"')

        if not value:
            continue

        if field == "brand_name":
            if operator in {"equals", "contains"}:
                filters.append(f'brand_name = "{value}"')

        elif field == "category":
            # categories is an array in Meili docs; subcategory is also indexed
            if operator == "equals":
                filters.append(f'categories = "{value}"')
            elif operator == "contains":
                # no true contains filter for arrays, so lean on lexical query for the term
                pass

    return " AND ".join(filters) if filters else None

def meili_text_search(text: str, conditions: list | None, limit: int = 50) -> list[dict]:
    if not meili_index:
        return []

    q = normalize_query(text or "")
    if not q and not conditions:
        return []

    params = {
        "limit": limit,
    }

    filter_text = build_meili_filter(conditions, active_only=True)
    if filter_text:
        params["filter"] = filter_text

    result = meili_index.search(q, params)
    hits = result.get("hits", []) or []

    out = []
    for rank, hit in enumerate(hits, start=1):
        out.append({
            "variant_id": hit.get("id"),
            "meili_rank": rank,
            "meili_score": 1.0 / (rank + 20.0),  # RRF-style soft score
            "meili_hit": hit,
        })
    return out


def normalize_clip_score(raw: float | None, threshold: float) -> float:
    if raw is None:
        return 0.0
    if raw <= threshold:
        return 0.0
    return min(1.0, max(0.0, (raw - threshold) / max(1e-6, (1.0 - threshold))))

def fetch_rows_for_variant_ids(variant_ids: list[str]) -> dict[str, dict]:
    if not variant_ids:
        return {}

    result = (
        supabase.table("product_catalogue_flat")
        .select(",".join([
            "variant_id",
            "product_id",
            "product_name",
            "variant_name",
            "model_number",
            "product_url",
            "brand_id",
            "brand_name",
            "category_name",
            "image_id",
            "image_url",
        ]))
        .in_("variant_id", variant_ids)
        .execute()
    )

    rows = result.data or []
    best_by_variant = {}

    for r in rows:
        vid = r.get("variant_id")
        if not vid:
            continue
        if vid not in best_by_variant:
            best_by_variant[vid] = r

    return best_by_variant

def fuse_text_results(
    vec_rows: list[dict],
    meili_rows: list[dict],
    threshold: float,
    top_k: int,
) -> list[dict]:
    combined = {}

    for r in vec_rows:
        variant_id = r.get("product_variant_id")
        if not variant_id:
            continue

        combined[variant_id] = {
            "variant_id": variant_id,
            "clip_row": r,
            "clip_score": normalize_clip_score(float(r.get("similarity") or 0), threshold),
            "meili_score": 0.0,
            "meili_rank": None,
        }

    for r in meili_rows:
        variant_id = r.get("variant_id")
        if not variant_id:
            continue

        item = combined.setdefault(variant_id, {
            "variant_id": variant_id,
            "clip_row": None,
            "clip_score": 0.0,
            "meili_score": 0.0,
            "meili_rank": None,
        })
        item["meili_score"] = max(item["meili_score"], float(r.get("meili_score") or 0))
        item["meili_rank"] = r.get("meili_rank")

    # weights:
    # - lexical precision from Meili matters a lot for brand/model/category text
    # - CLIP still helps on softer semantic terms
    for item in combined.values():
        item["final_score"] = (
            0.65 * item["meili_score"] +
            0.35 * item["clip_score"]
        )

    ranked = sorted(combined.values(), key=lambda x: x["final_score"], reverse=True)[:top_k]
    rows_by_variant = fetch_rows_for_variant_ids([x["variant_id"] for x in ranked])

    results = []
    for item in ranked:
        row = rows_by_variant.get(item["variant_id"])
        if not row:
            clip_row = item.get("clip_row") or {}
            row = {
                "variant_id": item["variant_id"],
                "product_id": clip_row.get("product_id"),
                "product_name": clip_row.get("product_name"),
                "variant_name": clip_row.get("variant_name"),
                "model_number": clip_row.get("model_number"),
                "product_url": clip_row.get("product_url"),
                "brand_id": clip_row.get("brand_id"),
                "brand_name": clip_row.get("brand_name"),
                "category_name": clip_row.get("product_category"),
                "image_id": clip_row.get("image_id"),
                "image_url": clip_row.get("image_url"),
            }

        results.append({
            "image_id": row.get("image_id"),
            "image_url": row.get("image_url"),
            "image_path": row.get("image_url"),
            "score": item["final_score"],
            "clip_score": item["clip_score"],
            "meili_score": item["meili_score"],
            "meili_rank": item["meili_rank"],
            "variant_id": row.get("variant_id"),
            "variant_name": row.get("variant_name"),
            "model_number": row.get("model_number"),
            "product_url": row.get("product_url"),
            "product_id": row.get("product_id"),
            "product_name": row.get("product_name"),
            "brand_id": row.get("brand_id"),
            "brand_name": row.get("brand_name"),
            "product_category": row.get("category_name"),
            "category_name": row.get("category_name"),
        })

    return results



def _normalize(nd: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(nd, axis=-1, keepdims=True)
    return nd / np.clip(n, 1e-12, None)


def encode_image(image: PILImage.Image) -> np.ndarray:
    model, preprocess = get_clip()
    x = preprocess(image).unsqueeze(0).to(device)
    with torch.no_grad():
        feat = model.encode_image(x).float()
    feat = feat.cpu().numpy().astype(np.float32)
    return _normalize(feat)

def encode_text(text: str) -> np.ndarray:
    model, _ = get_clip()
    tokens = clip.tokenize([text]).to(device)
    with torch.no_grad():
        feat = model.encode_text(tokens).float()
    feat = feat.cpu().numpy().astype(np.float32)
    return _normalize(feat)

# --------------------------
# FastAPI
# --------------------------
app = FastAPI(title="Lens Search API (pgvector)")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"]
)

@app.get("/")
def root():
    return {"ok": True, "msg": "API up — pgvector via RPC, no FAISS"}


@app.post("/search")
async def search(
    file: UploadFile | None = File(default=None),
    text: Optional[str] = Query(default=None),
    conditions_json: Optional[str] = Query(default=None),
    top_k: int = Query(20, ge=1, le=100),
    threshold: float = Query(0.25, ge=0.0, le=1.0),
):
    """Search products.

    Rules:
    - If an image is uploaded, use vector image search.
    - Otherwise use text search with Meilisearch + CLIP fusion.
    - Optional structured conditions are applied to the Meilisearch path.
    """
    if not file and not (text and text.strip()) and not conditions_json:
        raise HTTPException(status_code=400, detail="Provide 'file' or 'text'")

    conditions = []
    if conditions_json:
        try:
            parsed = json.loads(conditions_json)
            if isinstance(parsed, list):
                conditions = parsed
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid conditions_json")

    preview_data_url = None

    # ------------------
    # Image search ONLY → vector RPC
    # ------------------
    if file is not None:
        try:
            img = PILImage.open(io.BytesIO(await file.read())).convert("RGB")
            img.thumbnail((1024, 1024))
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid image upload")

        qvec = encode_image(img)[0].tolist()

        try:
            start = time.perf_counter()
            resp = supabase.rpc(
                "match_product_images",
                {
                    "query_embedding": qvec,
                    "match_count": int(top_k),
                    "threshold": float(threshold),
                },
            ).execute()
            duration = (time.perf_counter() - start) * 1000
            print(f"RPC/vector (image) took {duration:.2f} ms for top_k={top_k}, threshold={threshold}")
            rows = resp.data or []
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Vector search failed: {e}")

        def map_rpc_row(r: dict) -> dict:
            return {
                "image_id": r.get("image_id"),
                "image_url": r.get("image_url"),
                "image_path": r.get("image_url"),
                "score": r.get("similarity"),
                "variant_id": r.get("product_variant_id"),
                "variant_name": r.get("variant_name"),
                "model_number": r.get("model_number"),
                "product_url": r.get("product_url"),
                "product_id": r.get("product_id"),
                "product_name": r.get("product_name"),
                "brand_id": r.get("brand_id"),
                "brand_name": r.get("brand_name"),
                "product_category": r.get("product_category"),
                "category_name": r.get("product_category"),
            }

        results = [map_rpc_row(r) for r in rows]
        results.sort(key=lambda x: (x.get("score") or 0), reverse=True)
        return {"count": len(results), "results": results[:top_k], "preview": preview_data_url}

    # ------------------
    # Plain text search → Meili + CLIP hybrid
    # ------------------
    query_text = (text or "").strip()
    normalized_text = normalize_query(query_text)

    vec_rows = []

    meili_rows = []
    try:
        start = time.perf_counter()
        meili_rows = meili_text_search(
            text=normalized_text or query_text,
            conditions=conditions,
            limit=max(int(top_k) * 3, 50),
        )
        mdur = (time.perf_counter() - start) * 1000
        print(f"Meili text search took {mdur:.2f} ms")
    except Exception as e:
        print("Meili search failed:", e)

    results = fuse_text_results(
        vec_rows=vec_rows,
        meili_rows=meili_rows,
        threshold=float(threshold),
        top_k=int(top_k),
    )

    return {"count": len(results), "results": results[:top_k], "preview": preview_data_url}