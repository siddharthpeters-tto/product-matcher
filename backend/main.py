import os
import io
import json
import time
import hashlib
import random
import string
import traceback 
from tempfile import NamedTemporaryFile
from typing import Dict, List, Optional

import faiss
import numpy as np
import torch
import clip
from PIL import Image as PILImage
from dotenv import load_dotenv
from fastapi import FastAPI, File, UploadFile, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from supabase import create_client
from postgrest.exceptions import APIError
from modal_faiss_builder.faiss_sharding import load_sharded_index


os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"

print("🚀 Starting main.py...")

# --------------------------
# ENV + CLIP model
# --------------------------
load_dotenv()
print("✅ Environment loaded")

device = "cuda" if torch.cuda.is_available() else "cpu"
print(f"✅ Device: {device}")

model, preprocess = clip.load("ViT-B/32", device=device)
clip_dim = model.encode_image(torch.zeros((1, 3, 224, 224)).to(device)).shape[1]
print(f"✅ CLIP model loaded, embedding dim: {clip_dim}")

SUPABASE_URL = "https://rffqzfdzosambdxmpuac.supabase.co/"
SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmZnF6ZmR6b3NhbWJkeG1wdWFjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1MjEyNDIyOCwiZXhwIjoyMDY3NzAwMjI4fQ.Lsu2SmeJFL_LWTdUtIoNWrKABVxoPl91i4tpulF4UbA"
import requests
print("Testing Supabase connectivity...")
resp = requests.get(SUPABASE_URL + "/auth/v1")
print("Status:", resp.status_code)
print(f"Final SUPABASE_URL: '{SUPABASE_URL}'")
print(f"Final SUPABASE_KEY length: {len(SUPABASE_KEY)}")
print(f"First 20 chars of key: {SUPABASE_KEY[:20]}")

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
print("✅ Supabase client initialized")

# --------------------------
# Cache config
# --------------------------
CACHE_DIR = "/tmp/faiss_cache"
os.makedirs(CACHE_DIR, exist_ok=True)

# In-memory cache
memory_index_cache: Dict[str, faiss.Index] = {}
memory_idmap_cache: Dict[str, list] = {}
ALLOWED_INDEXES = {"color"}

# --------------------------
# Supabase helpers
# --------------------------
def supabase_download(bucket: str, path: str, retries: int = 3) -> Optional[str]:
    """Download with retries and local caching."""
    local_path = os.path.join(CACHE_DIR, path.replace("/", "_"))
    if os.path.exists(local_path):
        return local_path

    for attempt in range(retries):
        try:
            data = supabase.storage.from_(bucket).download(path)
            with open(local_path, "wb") as f:
                f.write(data)
            return local_path
        except Exception as e:
            print(f"⚠️ Download failed for {path}, attempt {attempt+1}/{retries}: {e}")
            time.sleep(1.5 * (attempt + 1))

    print(f"❌ Giving up on {path}")
    return None


def list_manifests(bucket: str) -> List[str]:
    """List all clip_*_manifest.json files in Supabase."""
    try:
        files = supabase.storage.from_(bucket).list()
        return [f["name"] for f in files if f["name"].endswith("_manifest.json")]
    except Exception as e:
        print(f"❌ Could not list manifests: {e}")
        return []


# --------------------------
# FAISS loader
# --------------------------
# Simplify index loading to use the sharded loader; no manifest "dimension" checks
def load_index_mode(mode: str, refresh_cache: bool = False):
    if not refresh_cache and mode in memory_index_cache:
        return memory_index_cache[mode], memory_idmap_cache[mode]

    # Build aggregated FAISS index from shards (L2 on normalized vectors)
    try:
        index = load_sharded_index(supabase, mode, expected_dim=clip_dim, threaded=True)
    except Exception as e:
        # Bubble up a clear error; the endpoint will convert to HTTP 503
        raise RuntimeError(f"Index load failed for '{mode}': {e}")

    idmap_path = supabase_download("faiss", f"id_map_{mode}.json")
    if not idmap_path:
        raise RuntimeError(f"ID map for {mode} missing.")
    with open(idmap_path, "r") as f:
        id_map = json.load(f)  # LIST

    memory_index_cache[mode] = index
    memory_idmap_cache[mode] = id_map
    return index, id_map



# --------------------------
# Encoders (L2-normalized)
# --------------------------
def encode_image(image: PILImage.Image):
    x = preprocess(image).unsqueeze(0).to(device)
    with torch.no_grad():
        feat = model.encode_image(x)
        feat = feat / feat.norm(dim=-1, keepdim=True)
    return feat.cpu().numpy().astype(np.float32)

def encode_text(text: str):
    tokens = clip.tokenize([text]).to(device)
    with torch.no_grad():
        feat = model.encode_text(tokens)
        feat = feat / feat.norm(dim=-1, keepdim=True)
    return feat.cpu().numpy().astype(np.float32)

# Utility: convert L2^2 distance to cosine similarity for normalized vectors
# For unit vectors: ||a-b||^2 = 2 - 2cos(a,b)  =>  cos = 1 - (d2/2)
def l2_to_cos(d2: float) -> float:
    return float(1.0 - (d2 / 2.0))

# --------------------------
# Metadata fetch (by image_id)
# --------------------------
def fetch_metadata_by_image_ids(image_ids: List[Optional[str]]):
    """Fetch product metadata by image_id in chunks and build lookup keyed by image_id."""
    all_metadata = {}
    chunk_size = 50
    for i in range(0, len(image_ids), chunk_size):
        chunk = [iid for iid in image_ids[i:i+chunk_size] if iid]
        if not chunk:
            continue
        try:
            resp = supabase.table("product_image_metadata") \
                .select("*") \
                .in_("image_id", chunk) \
                .execute()
            for row in resp.data:
                all_metadata[row["image_id"]] = row
        except APIError as e:
            print(f"❌ Metadata fetch error: {e}")
    return all_metadata


# --------------------------
# FastAPI
# --------------------------
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"]
)

# NEW unified search route to match your frontend's POST /search
@app.post("/search")
async def unified_search(
    file: UploadFile | None = File(default=None),
    text: Optional[str] = Query(default=None),
    index_type: str = Query("color"),
    top_k: int = Query(20),
    threshold: float = Query(0.25),  # cosine threshold after conversion
    refresh_cache: bool = Query(False),
):
    if not file and not (text and text.strip()):
        raise HTTPException(status_code=400, detail="Either 'file' or 'text' must be provided.")

    # 1) Collect keyword matches (TEXT ONLY) but do NOT early-return.
    kw_results = []
    if not file and text:
        try:
            kw = supabase.table("product_image_metadata") \
                .select("*") \
                .ilike("variant_name", f"%{text}%") \
                .limit(top_k) \
                .execute()
            if kw.data:
                for row in kw.data:
                    kw_results.append({
                        "image_id": row.get("image_id"),
                        "image_path": row.get("image_url"),
                        "score": 1.0,
                        "variant_id": row.get("variant_id"),
                        "variant_name": row.get("variant_name"),
                        "model_number": row.get("model_number"),
                        "product_id": row.get("product_id"),
                        "product_name": row.get("product_name"),
                        "brand_id": row.get("brand_id"),
                        "brand_name": row.get("brand_name"),
                        "product_url": row.get("product_url"),
                        "product_category": row.get("product_category"),
                    })
        except APIError as e:
            print(f"Keyword search error: {e}")

    if index_type not in ALLOWED_INDEXES:
        raise HTTPException(status_code=400, detail=f"Unsupported index_type '{index_type}'. Allowed: {sorted(ALLOWED_INDEXES)}")

    # 2) Vector search (image or text)
    try:
        index, id_map = load_index_mode(index_type, refresh_cache=refresh_cache)
        ntotal = int(getattr(index, "ntotal", 0))
        # add these 3 lines ↓↓↓
        if len(id_map) != ntotal:
            print(f"⚠️ id_map length {len(id_map)} != ntotal {ntotal} — TRIMMING FOR DEMO")
            id_map = id_map[:ntotal]
        # ✅ Always clamp top_k after load (even when lengths match)
        top_k = max(1, min(top_k, len(id_map), ntotal))
    except Exception as e:
        print("Index load failed:", e)
        traceback.print_exc()
        raise HTTPException(status_code=503, detail=str(e))

    # 3) If index is empty, fall back to keyword results for text queries (if any)
    if getattr(index, "ntotal", 0) == 0:
        if kw_results:
            return {"results": kw_results}
        return {"results": []}

    # 4) Build query embedding
    if file:
        img_bytes = await file.read()
        image = PILImage.open(io.BytesIO(img_bytes)).convert("RGB")
    else:
        query_vec = encode_text(text.strip())

    # 5) Run FAISS search (L2^2 on normalized vectors)
    D, I = index.search(query_vec, top_k)

    # 6) Map row indices -> image_ids with bounds checks
    def idx_to_image_id(ix: int) -> Optional[str]:
        if 0 <= ix < len(id_map):
            return id_map[ix]
        return None

    image_ids = [idx_to_image_id(ix) for ix in I[0]]

    # 7) Fetch metadata and assemble vector results
    meta = fetch_metadata_by_image_ids(image_ids)
    results = []
    for d2, ix in zip(D[0].tolist(), I[0].tolist()):
        image_id = idx_to_image_id(ix)
        if not image_id:
            continue
        row = meta.get(image_id)
        if not row:
            continue
        score_cos = l2_to_cos(d2)  # [-1, 1]; good matches often >= ~0.3+
        if score_cos < threshold:
            continue
        results.append({
            "image_id": row.get("image_id"),
            "image_path": row.get("image_url"),
            "score": score_cos,
            "variant_id": row.get("variant_id"),
            "variant_name": row.get("variant_name"),
            "model_number": row.get("model_number"),
            "product_id": row.get("product_id"),
            "product_name": row.get("product_name"),
            "brand_id": row.get("brand_id"),
            "brand_name": row.get("brand_name"),
            "product_url": row.get("product_url"),
            "product_category": row.get("product_category"),
        })

    # 8) Fallback: if vector results are empty after thresholding, return keyword hits (TEXT ONLY)
    if not results and kw_results:
        return {"results": kw_results}

    return {"results": results}

@app.get("/index/types")
async def list_index_types():
    manifests = list_manifests("faiss")
    return {"modes": [m.replace("clip_", "").replace("_manifest.json", "") for m in manifests]}

@app.get("/")
async def root():
    return {"message": "FAISS Sharded Search API (dynamic) is running"}

# Drop this into main.py (near other endpoints). Assumes you have:
# - load_index_mode(index_type: str, refresh_cache: bool=False) -> (faiss.Index, List[str])
# - supabase client already initialized (not required here)
#
# What it does:
# 1) Verifies len(id_map) == index.ntotal
# 2) Random round‑trip check: reconstruct vector for random labels and ensure the
#    top-1 nearest neighbor is the same label (i.e., mapping & add order aligned)
# 3) Reports average vector norm (to catch missing normalization)
# 4) Optional: force cache refresh for a cold, clean read of shards



@app.get("/diag/mapping")
async def diag_mapping(
    index_type: str = Query("color"),
    sample: int = Query(100, ge=5, le=2000),
    k: int = Query(1, ge=1, le=10),
    refresh_cache: bool = Query(False),
):
    index, id_map = load_index_mode(index_type, refresh_cache=refresh_cache)

    ntotal = int(getattr(index, "ntotal", 0))
    problems = []

    # (1) cardinality check
    cardinality_ok = (len(id_map) == ntotal)

    # (2) sample a set of labels to round-trip through search
    if ntotal == 0:
        return {
            "index_type": index_type,
            "ntotal": ntotal,
            "id_map_len": len(id_map),
            "cardinality_ok": cardinality_ok,
            "roundtrip_checked": 0,
            "roundtrip_ok_ratio": 0.0,
            "avg_norm": None,
            "problems": ["Empty index"]
        }

    labels = random.sample(range(ntotal), min(sample, ntotal))

    # compute norms to detect normalization mismatches
    norms = []
    ok_count = 0
    for lbl in labels:
        try:
            v = index.reconstruct(lbl)
        except Exception as e:
            problems.append(f"reconstruct failed for label {lbl}: {e}")
            continue

        # norm
        nrm = float(np.linalg.norm(v))
        norms.append(nrm)

        # search the same vector back; if mapping/order is correct, top-1 label should be lbl
        D, I = index.search(v.reshape(1, -1).astype(np.float32), k)
        top = int(I[0,0]) if I.size > 0 else -1
        if top == lbl:
            ok_count += 1
        else:
            problems.append(f"roundtrip mismatch: lbl={lbl} -> top={top}")

    roundtrip_ok_ratio = ok_count / max(1, len(labels))
    avg_norm = float(np.mean(norms)) if norms else None

    return {
        "index_type": index_type,
        "ntotal": ntotal,
        "id_map_len": len(id_map),
        "cardinality_ok": cardinality_ok,
        "roundtrip_checked": len(labels),
        "roundtrip_ok_ratio": roundtrip_ok_ratio,
        "avg_norm": avg_norm,
        "cache_refreshed": bool(refresh_cache),
        "problems": problems[:50],
    }

# Optional: quick dump of a few neighbor IDs for manual spot checks
@app.get("/diag/peek")
async def diag_peek(
    index_type: str = Query("color"),
    idx: int = Query(0, ge=0),
    k: int = Query(5, ge=1, le=50),
    refresh_cache: bool = Query(False),
):
    index, id_map = load_index_mode(index_type, refresh_cache=refresh_cache)
    ntotal = int(getattr(index, "ntotal", 0))
    if ntotal == 0:
        return {"error": "empty index"}
    idx = min(idx, ntotal-1)
    v = index.reconstruct(idx)
    D, I = index.search(v.reshape(1, -1).astype(np.float32), k)
    labels = I[0].tolist()
    uuids = [id_map[l] if 0 <= l < len(id_map) else None for l in labels]
    return {
        "query_label": idx,
        "query_uuid": id_map[idx] if idx < len(id_map) else None,
        "neighbors": [{"label": int(l), "uuid": u, "score": float(D[0][i])} for i, (l, u) in enumerate(zip(labels, uuids))]
    }
