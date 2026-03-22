import os, io, time
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, File, UploadFile, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from supabase import create_client
from pydantic import BaseModel
from typing import List, Literal
import json
from typing import Any
from openai import OpenAI
from prompts import SYSTEM_PROMPT, LLM_SYSTEM_MESSAGE


import base64
import torch, clip
import numpy as np
import psutil
import gc
from PIL import Image as PILImage
from rembg import remove, new_session

# --------------------------
# Env & Clients
# --------------------------
load_dotenv()
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
SUPABASE_URL="https://rffqzfdzosambdxmpuac.supabase.co/"
SUPABASE_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmZnF6ZmR6b3NhbWJkeG1wdWFjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTU2NjU1MTYsImV4cCI6MjA3MTI0MTUxNn0.bNj0M4SwVT0SVRVCFarBJLtBS-nYrSM7ZsZ_nGsMR5U"
if not SUPABASE_URL or not SUPABASE_KEY:
    raise RuntimeError("Missing SUPABASE_URL or SUPABASE_ANON_KEY in env")

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

# --------------------------
# Model (CLIP ViT-B/32)
# --------------------------
device = "cuda" if torch.cuda.is_available() else "cpu"
model, preprocess = clip.load("ViT-B/32", device=device)

# --------- BG removal session (reused) ---------
try:
    _rm_session = new_session("u2net")
    print("✅ Using u2net for background removal (lightweight)")
    # Commenting out the better rembg model because it takes up too much memory.
    #_rm_session = new_session("birefnet-general-lite")
    #print("✅ Using birefnet-general-lite for background removal")
except Exception as e:
    #print(f"⚠️ Failed to load birefnet-general-lite ({e}), falling back to u2net")
    #_rm_session = new_session("u2net")
    print(f"❌ Failed to load u2net: {e}")
    _rm_session = None

def canonicalize_filter_value(action, context):
    if not action or action.get("type") != "filter":
        return action

    filter_key = action.get("filterKey")
    raw_value = (action.get("value") or "").strip()
    if not filter_key or not raw_value:
        return action

    options = []
    if filter_key == "brand":
        options = [x.get("value") for x in (context.get("brandBreakdown") or []) if x.get("value")]
    elif filter_key == "category":
        options = [x.get("value") for x in (context.get("categoryBreakdown") or []) if x.get("value")]

    raw_lower = raw_value.lower()
    for opt in options:
        if opt.lower() == raw_lower:
            action["value"] = opt
            return action

    for opt in options:
        if opt.lower() in raw_lower or raw_lower in opt.lower():
            action["value"] = opt
            return action

    return action

def _ensure_rgb_jpeg_safe(pil_img: PILImage.Image) -> PILImage.Image:  # NEW
    # rembg may return RGBA; flatten to RGB so JPEG saves/embeds cleanly
    if pil_img.mode == "RGBA":
        bg = PILImage.new("RGB", pil_img.size, (255, 255, 255))
        bg.paste(pil_img, mask=pil_img.split()[3])
        return bg
    return pil_img.convert("RGB")



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

def log_memory(stage=""):
    mem = psutil.Process(os.getpid()).memory_info().rss / 1024 / 1024
    print(f"📊 Memory ({stage}): {mem:.2f} MB")

# --------------------------
# FastAPI
# --------------------------
app = FastAPI(title="Lens Search API (pgvector)")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"]
)

class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str

class ChatRequest(BaseModel):
    message: str
    history: List[ChatMessage] = []
    context: dict = {}

class ChatAction(BaseModel):
    type: Optional[str] = None
    query: Optional[str] = None
    filterKey: Optional[str] = None
    value: Optional[str] = None

class ChatResponse(BaseModel):
    reply: str
    action: Optional[ChatAction] = None

def build_chat_prompt(req: ChatRequest) -> str:
    ctx = req.context or {}
    count = ctx.get("resultCount", 0)
    has_image = ctx.get("hasImage", False)
    filters = ctx.get("filters", {}) or {}
    top_results = ctx.get("topResults", []) or []
    brand_breakdown = ctx.get("brandBreakdown", []) or []
    category_breakdown = ctx.get("categoryBreakdown", []) or []

    active_filters = {
        k: v for k, v in filters.items()
        if v and v != "all"
    }

    payload = {
        "user_message": req.message,
        "history": [m.model_dump() for m in req.history[-8:]],
        "context": {
            "hasImage": has_image,
            "resultCount": count,
            "activeFilters": active_filters,
            "topResults": top_results,
            "brandBreakdown": brand_breakdown,
            "categoryBreakdown": category_breakdown,
        },
    }

    return f"""
{SYSTEM_PROMPT}

Input:
{json.dumps(payload, ensure_ascii=False)}
""".strip()

def call_llm_for_chat(prompt: str) -> dict:
    try:
        from openai import OpenAI
    except ImportError:
        return {
            "reply": "The LLM client is not installed on the server yet.",
            "action": None,
        }

    if not OPENAI_API_KEY:
        return {
            "reply": "The assistant is not configured with an API key yet.",
            "action": None,
        }

    client = OpenAI(api_key=OPENAI_API_KEY)

    response = client.chat.completions.create(
        model="gpt-4o-mini",
        temperature=0.2,
        messages=[
            {"role": "system", "content": LLM_SYSTEM_MESSAGE},
            {"role": "user", "content": prompt},
        ],
    )

    content = response.choices[0].message.content

    try:
        return json.loads(content)
    except Exception:
        return {
            "reply": content or "I can help refine the current results.",
            "action": None,
        }
    
@app.post("/api/chat")
async def chat(req: ChatRequest):
    try:
        prompt = build_chat_prompt(req)
        raw = call_llm_for_chat(prompt)

        reply = raw.get("reply") or "I can help refine the current results."
        action = raw.get("action")

        # Canonicalize filter values against visible UI options
        action = canonicalize_filter_value(action, req.context or {})

        # Normalize action
        if not action or not action.get("type"):
            action = None
        else:
            action_type = action.get("type")
            if action_type not in {"search", "filter"}:
                action = None
            elif action_type == "search":
                if not action.get("query"):
                    action = None
            elif action_type == "filter":
                if action.get("filterKey") not in {"brand", "category"} or not action.get("value"):
                    action = None
        return {
            "reply": reply,
            "action": action
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/")
def root():
    return {"ok": True, "msg": "API up — pgvector via RPC, no FAISS"}


@app.post("/search")
async def search(
    file: UploadFile | None = File(default=None),
    text: Optional[str] = Query(default=None),
    top_k: int = Query(20, ge=1, le=100),
    threshold: float = Query(0.25, ge=0.0, le=1.0),
    remove_bg: int = Query(0),  # NEW (0 = off, 1 = on)
):
    """Return top-N most similar catalog images using pgvector HNSW (cosine).
    Either an image file OR a text string must be provided.
    """
    if not file and not (text and text.strip()):
        raise HTTPException(status_code=400, detail="Provide 'file' or 'text'")

    rows = []
    preview_data_url = None   # <— initialize ONCE here

    # ------------------
    # Image search ONLY → vector RPC
    # ------------------
    if file is not None:
        try:
            img = PILImage.open(io.BytesIO(await file.read())).convert("RGB")
            # Optional: Resize large images to max 1024px
            img.thumbnail((1024, 1024))
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid image upload")

        # Optional background removal (only if explicitly requested)
        if remove_bg == 1:
            try:
                log_memory("before remove()")
                cut = remove(img, session=_rm_session)
                log_memory("after remove()")
                img = _ensure_rgb_jpeg_safe(cut)
                buf = io.BytesIO()
                img.save(buf, format="JPEG", quality=92)
                preview_data_url = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"BG removal failed: {e}")
            finally:
                del cut
                del buf
                gc.collect()


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
            duration = (time.perf_counter() - start) * 1000  # ms
            print(f"RPC/vector (image) took {duration:.2f} ms for top_k={top_k}, threshold={threshold}")
            rows = resp.data or []
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Vector search failed: {e}")

    # ------------------
    # Text search → HYBRID (vector + keyword RPC)
    # ------------------
    else:
        qvec = encode_text(text.strip())[0].tolist()

        # Vector RPC
        vec_rows = []
        try:
            start = time.perf_counter()
            vresp = supabase.rpc(
                "match_product_images",
                {"query_embedding": qvec, "match_count": int(top_k), "threshold": float(threshold)},
            ).execute()
            vdur = (time.perf_counter() - start) * 1000
            print(f"RPC/vector (text) took {vdur:.2f} ms for top_k={top_k}, threshold={threshold}")
            vec_rows = vresp.data or []
        except Exception as e:
            print("Vector RPC failed:", e)

        # Keyword RPC
        kw_rows = []
        try:
            start = time.perf_counter()
            kresp = supabase.rpc(
                "keyword_match_product_images",
                {"q": text.strip(), "match_count": int(top_k)},
            ).execute()
            kdur = (time.perf_counter() - start) * 1000
            print(f"RPC/keyword took {kdur:.2f} ms for top_k={top_k}")
            kw_rows = kresp.data or []
        except Exception as e:
            print("Keyword RPC failed:", e)

        # Merge & dedupe by image_id (prefer vector entry if duplicate)
        by_id = {}
        for r in vec_rows:
            by_id[r.get("image_id")] = r
        for r in kw_rows:
            _id = r.get("image_id")
            if _id not in by_id:
                # optional: bump similarity so keyword-only hits float up
                r["similarity"] = max(0.99, float(r.get("similarity") or 0))
                by_id[_id] = r
        rows = list(by_id.values())

    # Normalize output structure for frontend
    def map_row(r: dict) -> dict:
        return {
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
    print("DEBUG keys:", rows[0].keys() if rows else "NO ROWS")
    results = [map_row(r) for r in rows]

    # Optional: sort by score desc after merging (text path)
    results.sort(key=lambda x: (x.get("score") or 0), reverse=True)

    # Return with timing not kept across both branches; could be added if needed
    return {"count": len(results), "results": results, "preview": preview_data_url}
