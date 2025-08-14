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
from fastapi import FastAPI, File, UploadFile, Query
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

SUPABASE_URL = os.getenv("SUPABASE_URL") or None
SUPABASE_KEY = os.getenv("SUPABASE_KEY") or None

if not SUPABASE_URL:
    SUPABASE_URL = "https://rffqzfdzosambdxmpuac.supabase.co/"
if not SUPABASE_KEY:
    SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmZnF6ZmR6b3NhbWJkeG1wdWFjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1MjEyNDIyOCwiZXhwIjoyMDY3NzAwMjI4fQ.Lsu2SmeJFL_LWTdUtIoNWrKABVxoPl91i4tpulF4UbA"
#if not SUPABASE_URL or not SUPABASE_KEY:
#    raise ValueError("Supabase credentials missing.")

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
print("✅ Supabase client initialized")

# --------------------------
# Cache config
# --------------------------
CACHE_DIR = "/tmp/faiss_cache"
os.makedirs(CACHE_DIR, exist_ok=True)

# In-memory cache
memory_index_cache: Dict[str, faiss.Index] = {}
memory_idmap_cache: Dict[str, dict] = {}

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
def load_index_mode(mode: str, refresh_cache: bool = False):
    """Load FAISS index & ID map for a mode (lazy, cached)."""
    if not refresh_cache and mode in memory_index_cache:
        return memory_index_cache[mode], memory_idmap_cache[mode]

    manifest_path = supabase_download("faiss", f"clip_{mode}_manifest.json")
    if not manifest_path:
        raise RuntimeError(f"Manifest for {mode} missing.")

    with open(manifest_path, "r") as f:
        manifest = json.load(f)

    # Check dimension match
    if manifest.get("dimension") != clip_dim:
        raise ValueError(f"Dimension mismatch for {mode}: manifest={manifest.get('dimension')} model={clip_dim}")

    shards = manifest.get("shards", [])
    if not shards:
        raise ValueError(f"No shards in manifest for {mode}")

    # Check integrity
    for shard in shards:
        if not supabase_download("faiss", shard):
            raise RuntimeError(f"Shard missing: {shard}")

    shard_paths = [supabase_download("faiss", shard) for shard in shards]

    index = load_sharded_index(supabase, mode, expected_dim=manifest["dimension"])

    idmap_path = supabase_download("faiss", f"id_map_{mode}.json")
    if not idmap_path:
        raise RuntimeError(f"ID map for {mode} missing.")
    with open(idmap_path, "r") as f:
        id_map = json.load(f)

    memory_index_cache[mode] = index
    memory_idmap_cache[mode] = id_map
    return index, id_map


# --------------------------
# Helpers
# --------------------------
def encode_image(image: PILImage.Image):
    image = preprocess(image).unsqueeze(0).to(device)
    with torch.no_grad():
        return model.encode_image(image).cpu().numpy().astype(np.float32)

def encode_text(text: str):
    text = clip.tokenize([text]).to(device)
    with torch.no_grad():
        return model.encode_text(text).cpu().numpy().astype(np.float32)

def fetch_metadata(ids):
    """Fetch product metadata in chunks."""
    all_metadata = {}
    chunk_size = 50
    for i in range(0, len(ids), chunk_size):
        chunk = [id for id in ids[i:i+chunk_size] if id]
        if not chunk:
            continue
        try:
            resp = supabase.table("product_image_metadata").select("*").in_("variant_id", chunk).execute()
            for row in resp.data:
                all_metadata[row["variant_id"]] = row
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

@app.post("/search/image")
async def search_image(
    file: UploadFile = File(...),
    index_type: str = Query("combined"),
    top_k: int = Query(10),
    refresh_cache: bool = Query(False)
):
    index, id_map = load_index_mode(index_type, refresh_cache=refresh_cache)

    img_bytes = await file.read()
    image = PILImage.open(io.BytesIO(img_bytes)).convert("RGB")
    if index_type == "structure":
        image = image.convert("L").convert("RGB")

    embedding = encode_image(image)
    D, I = index.search(embedding, top_k)
    ids = [id_map.get(str(idx)) for idx in I[0]]
    metadata = fetch_metadata(ids)
    return {"ids": ids, "scores": D[0].tolist(), "metadata": metadata}

@app.get("/search/text")
async def search_text(
    query: str,
    index_type: str = Query("combined"),
    top_k: int = Query(10),
    refresh_cache: bool = Query(False)
):
    # Keyword search first
    try:
        keyword_res = supabase.table("product_image_metadata").select("*").ilike("variant_name", f"%{query}%").limit(top_k).execute()
        if keyword_res.data:
            return {
                "ids": [row["variant_id"] for row in keyword_res.data],
                "scores": [1.0] * len(keyword_res.data),
                "metadata": {row["variant_id"]: row for row in keyword_res.data}
            }
    except APIError as e:
        print(f"Keyword search error: {e}")

    # CLIP fallback
    index, id_map = load_index_mode(index_type, refresh_cache=refresh_cache)
    embedding = encode_text(query)
    D, I = index.search(embedding, top_k)
    ids = [id_map.get(str(idx)) for idx in I[0]]
    metadata = fetch_metadata(ids)
    return {"ids": ids, "scores": D[0].tolist(), "metadata": metadata}

@app.get("/index/types")
async def list_index_types():
    manifests = list_manifests("faiss")
    return {"modes": [m.replace("clip_", "").replace("_manifest.json", "") for m in manifests]}

@app.get("/")
async def root():
    return {"message": "FAISS Sharded Search API (dynamic) is running"}

