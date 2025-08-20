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
from faiss_sharding import load_sharded_index


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

SUPABASE_URL = os.getenv("SUPABASE_URL", "")
# Use anon key for public, read-only access guarded by RLS.
SUPABASE_URL = "https://rffqzfdzosambdxmpuac.supabase.co/"
SUPABASE_KEY= "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmZnF6ZmR6b3NhbWJkeG1wdWFjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NTY2NTUxNiwiZXhwIjoyMDcxMjQxNTE2fQ.l9wlyn_1_GE4TTdQADbbdlZcn-EKZjb0hnwhnTvOGlY"
#SUPABASE_KEY = os.getenv("SUPABASE_ANON_KEY", "")
if not SUPABASE_URL or not SUPABASE_KEY:
    raise RuntimeError("Missing SUPABASE_URL or SUPABASE_ANON_KEY in env.")


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

import faiss  # ensure imported

def _to_cosine_scores(index: faiss.Index, D_row):
    """
    Convert FAISS output to cosine similarity in [-1, 1].
    - If shards were built with IP (your case), D is already cosine.
    - If (rarely) L2 on unit vectors, convert via cos = 1 - d2/2.
    """
    metric = getattr(index, "metric_type", getattr(faiss, "METRIC_INNER_PRODUCT", None))
    if metric == getattr(faiss, "METRIC_INNER_PRODUCT", None):
        return [float(x) for x in D_row]
    else:
        return [1.0 - float(x) / 2.0]

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
    allow_origins=[os.getenv("ALLOWED_ORIGIN", "https://your-frontend-domain")],
    allow_credentials=True, allow_methods=["POST","GET"], allow_headers=["*"]
)

# NEW unified search route to match your frontend's POST /search
@app.post("/search")
async def unified_search(
    file: UploadFile | None = File(default=None),
    text: Optional[str] = Query(default=None),
    index_type: str = Query("color"),
    top_k: int = Query(20),
    threshold: float = Query(0.25),
    refresh_cache: bool = Query(False),
):
    if not file and not (text and text.strip()):
        raise HTTPException(status_code=400, detail="Either 'file' or 'text' must be provided.")

    # 1) Collect keyword matches (TEXT ONLY) but do NOT early-return.
    kw_results = []
    if not file and text:
        try:
            t = text.strip().replace("%","")  # simple sanitize
            kw = (supabase.table("product_image_metadata")
                .select("*")
                .or_(f"variant_name.ilike.%{t}%,"
                    f"product_name.ilike.%{t}%,"
                    f"brand_name.ilike.%{t}%,"
                    f"model_number.ilike.%{t}%")
                .limit(top_k)
                .execute())
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
        query_vec = encode_image(image)          # ← ADD THIS LINE
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
    cos_scores = _to_cosine_scores(index, D[0])
    for ix, score_cos in zip(I[0].tolist(), cos_scores):
        image_id = idx_to_image_id(ix)
        if not image_id:
            continue
        row = meta.get(image_id)
        if not row:
            continue
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