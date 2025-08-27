import os, io
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
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_KEY = os.getenv("SUPABASE_ANON_KEY", "")  # read-only key behind RLS
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
        resp = supabase.rpc(
            "match_product_images",
            {
                "query_embedding": qvec,
                "match_count": int(top_k),
                "threshold": float(threshold),
            },
        ).execute()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Vector search failed: {e}")

    rows = resp.data or []
    # Normalize output structure for frontend
    results = [
        {
            "image_id": r.get("image_id"),
            "image_url": r.get("image_url"),
            "score": r.get("similarity"),  # cosine similarity in [0,1]
            "variant": {
                "id": r.get("product_variant_id"),
                "name": r.get("variant_name"),
                "model_number": r.get("model_number"),
                "product_url": r.get("product_url"),
            },
            "product": {
                "id": r.get("product_id"),
                "name": r.get("product_name"),
            },
            "brand": {
                "id": r.get("brand_id"),
                "name": r.get("brand_name"),
            },
        }
        for r in rows
    ]

    return {"count": len(results), "results": results}
