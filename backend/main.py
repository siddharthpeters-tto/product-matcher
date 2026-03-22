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
    if not isinstance(action, dict):
        return action

    if action.get("type") != "filter":
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

class ChatCondition(BaseModel):
    field: str
    operator: str = "equals"
    value: str

class ChatAction(BaseModel):
    type: Optional[str] = None
    query: Optional[str] = None
    filterKey: Optional[str] = None
    value: Optional[str] = None
    metric: Optional[str] = None
    field: Optional[str] = None
    conditions: Optional[List[ChatCondition]] = None

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

def normalize_aggregate_action(action: dict):
    if not isinstance(action, dict):
        return action

    if action.get("type") != "aggregate":
        return action

    conditions = action.get("conditions")
    if isinstance(conditions, list) and len(conditions) > 0:
        return action

    field = action.get("field")
    value = action.get("value")

    if field and value:
        operator = "contains" if field == "category" else "equals"
        action["conditions"] = [
            {
                "field": field,
                "operator": operator,
                "value": value,
            }
        ]

    return action

def apply_search_conditions(results: list, conditions: list):
    if not conditions:
        return results

    def matches(item, cond):
        field = cond.get("field")
        operator = cond.get("operator")
        value = (cond.get("value") or "").strip().lower()

        if not value:
            return True

        if field == "brand_name":
            actual = str(
                item.get("brand_name")
                or item.get("brand")
                or ""
            ).strip().lower()

            if operator == "equals":
                return actual == value
            if operator == "contains":
                return value in actual

        if field == "category":
            actual = str(
                item.get("category_name")
                or item.get("product_category")
                or item.get("category")
                or ""
            ).strip().lower()

            if operator == "equals":
                return actual == value
            if operator == "contains":
                return value in actual

        return True

    filtered = []
    for item in results:
        if all(matches(item, cond) for cond in conditions):
            filtered.append(item)

    return filtered

def run_aggregate_action(action: dict):
    metric = action.get("metric")
    conditions = action.get("conditions") or []

    if metric != "count":
        raise ValueError("Unsupported aggregate metric")

    if not conditions:
        raise ValueError("Aggregate requires at least one condition")

    query = supabase.table("product_catalogue_flat").select("product_id")

    applied_conditions = []

    for cond in conditions:
        field = cond.get("field")
        operator = cond.get("operator")
        value = (cond.get("value") or "").strip()

        if not value:
            raise ValueError("Aggregate condition missing value")

        if field == "category":
            if operator == "contains":
                query = query.ilike("category_name", f"%{value}%")
            elif operator == "equals":
                query = query.ilike("category_name", value)
            else:
                raise ValueError("Unsupported category operator")

        elif field == "brand_name":
            if operator == "equals":
                query = query.ilike("brand_name", value)
            elif operator == "contains":
                query = query.ilike("brand_name", f"%{value}%")
            else:
                raise ValueError("Unsupported brand operator")

        else:
            raise ValueError(f"Unsupported aggregate field: {field}")

        applied_conditions.append({
            "field": field,
            "operator": operator,
            "value": value,
        })

    result = query.execute()

    product_ids = {
        row["product_id"]
        for row in (result.data or [])
        if row.get("product_id")
    }

    return {
        "metric": metric,
        "conditions": applied_conditions,
        "count": len(product_ids),
    }

    
@app.post("/api/chat")
async def chat(req: ChatRequest):
    try:
        print("CHAT CONTEXT:", req.context)

        prompt = build_chat_prompt(req)
        raw = call_llm_for_chat(prompt)

        if not isinstance(raw, dict):
            raw = {
                "reply": "I couldn’t interpret that response reliably.",
                "action": None,
            }

        reply = raw.get("reply") or "I can help refine the current results."
        action = raw.get("action")

        if not isinstance(action, dict):
            action = None

        # Canonicalize filter values against visible UI options
        action = canonicalize_filter_value(action, req.context or {})

        # Normalize aggregate actions so old single-field outputs
        # still become conditions-based actions
        action = normalize_aggregate_action(action)

        if not action or not action.get("type"):
            action = None
        else:
            action_type = action.get("type")

            if action_type not in {"search", "filter", "aggregate", None}:
                action = None

            elif action_type == "filter":
                if action.get("filterKey") not in {"brand", "category"}:
                    action = None
                elif not action.get("value"):
                    action = None
                else:
                    action = {
                        "type": "filter",
                        "query": None,
                        "filterKey": action.get("filterKey"),
                        "value": action.get("value"),
                        "metric": None,
                        "field": None,
                        "conditions": None,
                    }

            elif action_type == "search":
                query = (action.get("query") or "").strip()
                conditions = action.get("conditions") or []

                if not query and not conditions:
                    action = None
                else:
                    normalized_conditions = []

                    for cond in conditions:
                        if not isinstance(cond, dict):
                            action = None
                            break

                        field = cond.get("field")
                        operator = cond.get("operator")
                        value = (cond.get("value") or "").strip()

                        if field not in {"category", "brand_name"}:
                            action = None
                            break

                        if operator not in {"equals", "contains"}:
                            action = None
                            break

                        if not value:
                            action = None
                            break

                        normalized_conditions.append({
                            "field": field,
                            "operator": operator,
                            "value": value,
                        })

                    if action is not None:
                        action = {
                            "type": "search",
                            "query": query or None,
                            "filterKey": None,
                            "value": None,
                            "metric": None,
                            "field": None,
                            "conditions": normalized_conditions or None,
                        }

            elif action_type == "aggregate":
                metric = action.get("metric")
                conditions = action.get("conditions") or []

                if metric not in {"count"}:
                    action = None
                elif not isinstance(conditions, list) or not conditions:
                    action = None
                else:
                    normalized_conditions = []

                    for cond in conditions:
                        if not isinstance(cond, dict):
                            action = None
                            break

                        field = cond.get("field")
                        operator = cond.get("operator")
                        value = (cond.get("value") or "").strip()

                        if field not in {"category", "brand_name"}:
                            action = None
                            break

                        if operator not in {"equals", "contains"}:
                            action = None
                            break

                        if not value:
                            action = None
                            break

                        normalized_conditions.append({
                            "field": field,
                            "operator": operator,
                            "value": value,
                        })

                    if action is not None:
                        action = {
                            "type": "aggregate",
                            "query": None,
                            "filterKey": None,
                            "value": None,
                            "metric": metric,
                            "field": None,
                            "conditions": normalized_conditions,
                        }

            else:
                action = None

        aggregate_result = None

        if action and action.get("type") == "aggregate":
            try:
                aggregate_result = run_aggregate_action(action)
                count = aggregate_result["count"]
                conditions = aggregate_result.get("conditions", [])

                if len(conditions) == 1:
                    cond = conditions[0]
                    field = cond["field"]
                    value = cond["value"]

                    if field == "category":
                        reply = f"We currently have {count} products in the category '{value}'."
                    elif field == "brand_name":
                        reply = f"We currently have {count} products for the brand '{value}'."
                    else:
                        reply = f"We currently have {count} matching products."
                else:
                    label_parts = []
                    for cond in conditions:
                        if cond["field"] == "brand_name":
                            label_parts.append(cond["value"])
                        elif cond["field"] == "category":
                            label_parts.append(cond["value"])

                    if label_parts:
                        reply = f"We currently have {count} products matching {' + '.join(label_parts)}."
                    else:
                        reply = f"We currently have {count} products matching those catalogue conditions."

            except Exception as e:
                print("aggregate error:", e)
                aggregate_result = None
                action = None
                reply = "I couldn’t run that catalogue query reliably. Try rephrasing it as a search."

        return {
            "reply": reply,
            "action": action,
            "aggregate_result": aggregate_result,
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
    conditions_json: Optional[str] = Query(default=None),
    top_k: int = Query(20, ge=1, le=100),
    threshold: float = Query(0.25, ge=0.0, le=1.0),
    remove_bg: int = Query(0),
):
    """Search products.

    Rules:
    - If an image is uploaded, use the existing vector image search path.
    - If text search includes structured conditions, use direct Supabase catalogue query.
    - If text search has no structured conditions, use the existing hybrid vector + keyword path.
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

    rows = []
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
                try:
                    del cut
                except Exception:
                    pass
                try:
                    del buf
                except Exception:
                    pass
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
    # Structured text search → direct Supabase query
    # ------------------
    if conditions:
        try:
            query = supabase.table("product_catalogue_flat").select(
                ",".join([
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
                ])
            )

            for cond in conditions:
                field = cond.get("field")
                operator = cond.get("operator")
                value = (cond.get("value") or "").strip()

                if not value:
                    continue

                if field == "brand_name":
                    if operator == "equals":
                        query = query.ilike("brand_name", value)
                    elif operator == "contains":
                        query = query.ilike("brand_name", f"%{value}%")

                elif field == "category":
                    if operator == "equals":
                        query = query.ilike("category_name", value)
                    elif operator == "contains":
                        query = query.ilike("category_name", f"%{value}%")

            result = query.limit(int(top_k)).execute()
            rows = result.data or []

        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Structured catalogue search failed: {e}")

        results = []
        seen = set()

        for r in rows:
            variant_id = r.get("variant_id")
            product_id = r.get("product_id")
            image_id = r.get("image_id")
            dedupe_key = variant_id or product_id

            if dedupe_key in seen:
                continue
            seen.add(dedupe_key)

            results.append({
                "image_id": r.get("image_id"),
                "image_url": r.get("image_url"),
                "image_path": r.get("image_url"),
                "score": 1.0,
                "variant_id": variant_id,
                "variant_name": r.get("variant_name"),
                "model_number": r.get("model_number"),
                "product_url": r.get("product_url"),
                "product_id": product_id,
                "product_name": r.get("product_name"),
                "brand_id": r.get("brand_id"),
                "brand_name": r.get("brand_name"),
                "product_category": r.get("category_name"),
                "category_name": r.get("category_name"),
            })

        return {"count": len(results), "results": results[:top_k], "preview": None}
    # ------------------
    # Plain text search → existing HYBRID vector + keyword path
    # ------------------
    qvec = encode_text(text.strip())[0].tolist()

    vec_rows = []
    try:
        start = time.perf_counter()
        vresp = supabase.rpc(
            "match_product_images",
            {
                "query_embedding": qvec,
                "match_count": int(top_k),
                "threshold": float(threshold),
            },
        ).execute()
        vdur = (time.perf_counter() - start) * 1000
        print(f"RPC/vector (text) took {vdur:.2f} ms for top_k={top_k}, threshold={threshold}")
        vec_rows = vresp.data or []
    except Exception as e:
        print("Vector RPC failed:", e)

    kw_rows = []
    try:
        start = time.perf_counter()
        kresp = supabase.rpc(
            "keyword_match_product_images",
            {
                "q": text.strip(),
                "match_count": int(top_k),
            },
        ).execute()
        kdur = (time.perf_counter() - start) * 1000
        print(f"RPC/keyword took {kdur:.2f} ms for top_k={top_k}")
        kw_rows = kresp.data or []
    except Exception as e:
        print("Keyword RPC failed:", e)

    by_id = {}
    for r in vec_rows:
        by_id[r.get("image_id")] = r
    for r in kw_rows:
        _id = r.get("image_id")
        if _id not in by_id:
            r["similarity"] = max(0.99, float(r.get("similarity") or 0))
            by_id[_id] = r
    rows = list(by_id.values())

    def map_row(r: dict) -> dict:
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

    results = [map_row(r) for r in rows]
    results.sort(key=lambda x: (x.get("score") or 0), reverse=True)

    return {"count": len(results), "results": results[:top_k], "preview": preview_data_url}