import os
import io
import json
import time
import hashlib
import random
import string
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
    index = load_sharded_index(supabase, mode, expected_dim=clip_dim, threaded=True)

    # id_map lives in Supabase as JSON: id_map_{mode}.json
    idmap_path = supabase_download("faiss", f"id_map_{mode}.json")
    if not idmap_path:
        raise RuntimeError(f"ID map for {mode} missing.")
    with open(idmap_path, "r") as f:
        id_map = json.load(f)  # <-- LIST of image_ids in FAISS row order

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
    index_type: str = Query("combined"),
    top_k: int = Query(20),
    threshold: float = Query(0.25),  # currently applied on cosine-like score after conversion
    refresh_cache: bool = Query(False),
):
    if not file and not (text and text.strip()):
        raise HTTPException(status_code=400, detail="Either 'file' or 'text' must be provided.")

    # Keyword shortcut only for text queries
    if not file and text:
        try:
            kw = supabase.table("product_image_metadata") \
                .select("*") \
                .ilike("variant_name", f"%{text}%") \
                .limit(top_k) \
                .execute()
            if kw.data:
                results = []
                for row in kw.data:
                    results.append({
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
                return {"results": results}
        except APIError as e:
            print(f"Keyword search error: {e}")

    # Vector search (image or text)
    index, id_map = load_index_mode(index_type, refresh_cache=refresh_cache)

    # Early guard if index is empty
    if getattr(index, "ntotal", 0) == 0:
        return {"results": []}

    if file:
        img_bytes = await file.read()
        image = PILImage.open(io.BytesIO(img_bytes)).convert("RGB")
        if index_type == "structure":
            image = image.convert("L").convert("RGB")
        query_vec = encode_image(image)
    else:
        query_vec = encode_text(text.strip())

    # FAISS returns squared L2 distances on normalized vectors
    D, I = index.search(query_vec, top_k)

    # id_map is a LIST; convert indices -> image_ids with bounds checks
    def idx_to_image_id(ix: int) -> Optional[str]:
        if 0 <= ix < len(id_map):
            return id_map[ix]
        return None

    image_ids = [idx_to_image_id(ix) for ix in I[0]]

    # Fetch metadata and assemble response in the exact shape the frontend expects
    meta = fetch_metadata_by_image_ids(image_ids)
    results = []
    for d2, ix in zip(D[0].tolist(), I[0].tolist()):
        image_id = idx_to_image_id(ix)
        if not image_id:
            continue
        row = meta.get(image_id)
        if not row:
            continue
        score_cos = l2_to_cos(d2)  # in [-1,1]; typical good matches >= ~0.3+
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

    return {"results": results}

@app.get("/index/types")
async def list_index_types():
    manifests = list_manifests("faiss")
    return {"modes": [m.replace("clip_", "").replace("_manifest.json", "") for m in manifests]}

@app.get("/")
async def root():
    return {"message": "FAISS Sharded Search API (dynamic) is running"}
