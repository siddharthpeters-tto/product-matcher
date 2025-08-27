import os, io, time
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, File, UploadFile, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from supabase import create_client

import torch, clip
import numpy as np
from PIL import Image as PILImage

# --------------------------
# Env & Clients
# --------------------------
load_dotenv()
SUPABASE_URL="https://rffqzfdzosambdxmpuac.supabase.co/"
SUPABASE_ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmZnF6ZmR6b3NhbWJkeG1wdWFjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTU2NjU1MTYsImV4cCI6MjA3MTI0MTUxNn0.bNj0M4SwVT0SVRVCFarBJLtBS-nYrSM7ZsZ_nGsMR5U"
if not SUPABASE_URL or not SUPABASE_KEY:
    raise RuntimeError("Missing SUPABASE_URL or SUPABASE_ANON_KEY in env")

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

# --------------------------
# Model (CLIP ViT-B/32)
# --------------------------
device = "cuda" if torch.cuda.is_available() else "cpu"
model, preprocess = clip.load("ViT-B/32", device=device)


def _normalize(nd: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(nd, axis=-1, keepdims=True)
    return nd / np.clip(n, 1e-12, None)


def encode_image(image: PILImage.Image) -> np.ndarray:
    x = preprocess(image).unsqueeze(0).to(device)
    with torch.no_grad():
        feat = model.encode_image(x).float()
    feat = feat.cpu().numpy().astype(np.float32)
    return _normalize(feat)


def encode_text(text: str) -> np.ndarray:
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
    top_k: int = Query(20, ge=1, le=100),
    threshold: float = Query(0.25, ge=0.0, le=1.0),
):
    """Return top-N most similar catalog images using pgvector HNSW (cosine).
    Either an image file OR a text string must be provided.
    """
    if not file and not (text and text.strip()):
        raise HTTPException(status_code=400, detail="Provide 'file' or 'text'")

    # Build query embedding (512-dim, L2-normalized)
    if file is not None:
        try:
            img = PILImage.open(io.BytesIO(await file.read())).convert("RGB")
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid image upload")
        qvec = encode_image(img)[0].tolist()
    else:
        qvec = encode_text(text.strip())[0].tolist()

    # Vector search via RPC (uses existing HNSW index on product_images.embedding)
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
        duration = (time.perf_counter() - start) * 1000  # ms
        print(f"RPC call took {duration:.2f} ms for top_k={top_k}, threshold={threshold}")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Vector search failed: {e}")

    rows = resp.data or []
    # Normalize output structure for frontend
    results = [
        {
            "image_id": r.get("image_id"),
            "image_url": r.get("image_url"),
            "image_path": r.get("image_url"),  # alias for frontend compatibility
            "score": r.get("similarity"),  # cosine similarity in [0,1]
            "variant_id": r.get("product_variant_id"),
            "variant_name": r.get("variant_name"),
            "model_number": r.get("model_number"),
            "product_url": r.get("product_url"),
            "product_id": r.get("product_id"),
            "product_name": r.get("product_name"),
            "brand_id": r.get("brand_id"),
            "brand_name": r.get("brand_name"),
            "product_category": r.get("product_category"),
        }
        for r in rows
    ]

    return {"count": len(results), "results": results, "rpc_time_ms": duration}
