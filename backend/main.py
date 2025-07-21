import os, io, json
import faiss
import numpy as np
from tempfile import NamedTemporaryFile
from PIL import Image as PILImage
from fastapi import FastAPI, UploadFile, File, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import torch
import clip
import hashlib
from dotenv import load_dotenv
from supabase import create_client
from postgrest.exceptions import APIError

os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"


print("🚀 Starting main.py...")

load_dotenv()
print("✅ Environment loaded")
device = "cuda" if torch.cuda.is_available() else "cpu"
print(f"✅ Device: {device}")

try:
    model, preprocess = clip.load("ViT-B/32", device=device)
    print("✅ CLIP model loaded")
except Exception as e:
    print(f"❌ Failed to load CLIP model: {e}")

supabase = create_client(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY"))
print("✅ Supabase client initialized")

def download_file(bucket, path):
    try:
        data = supabase.storage.from_(bucket).download(path)
        tmp = NamedTemporaryFile(delete=False)
        tmp.write(data)
        tmp.flush()
        return tmp.name
    except Exception as e:
        print(f"❌ Failed to download {path}: {e}")
        return None

# Load FAISS indexes and ID maps
index_map = {}
id_maps = {}
for mode in ["color", "structure", "combined"]:
    index_path = download_file("faiss", f"clip_{mode}.index")
    id_map_path = download_file("faiss", f"id_map_{mode}.json")

    if not index_path or not id_map_path:
        print(f"⚠️ Skipping index: {mode}")
        continue

    try:
        index_map[mode] = faiss.read_index(index_path)
        with open(id_map_path, "r") as f:
            id_maps[mode] = json.load(f)
        print(f"✅ Loaded FAISS index for {mode}")
    except Exception as e:
        print(f"❌ Error loading {mode} index: {e}")

# FastAPI app
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.post("/search")
async def search(
    file: UploadFile = File(None),
    text: str = Query(None),
    index_type: str = Query("combined"),  # You said this is your default now
    threshold: float = Query(0.75),
    top_k: int = Query(20)
):
    if not file and not text:
        return JSONResponse({"error": "Either 'file' or 'text' must be provided."}, status_code=400)

    results = []

    if text:
        keyword = text.lower()
        keyword_expr = (
            "or("
            f"variant_name.ilike.%{keyword}%,"
            f"model_number.ilike.%{keyword}%,"
            f"product_name.ilike.%{keyword}%"
            ")"
        )

        # 🔍 Bonus Debug Tip — see exactly what's being passed to Supabase
        print("🔍 Supabase keyword filter expression:", keyword_expr)

        try:
            keyword_resp = (
                supabase.table("product_image_metadata_view")
                .select("*")
                .filter("or", keyword_expr)
                .limit(top_k)
                .execute()
            )
            print(f"✅ Supabase query returned {len(keyword_resp.data)} results")

            if keyword_resp.data:
                for record in keyword_resp.data:
                    results.append({
                        "image_id": record["image_id"],
                        "image_path": record["image_url"],
                        "score": 1.0,
                        "variant_id": record.get("variant_id"),
                        "variant_name": record.get("variant_name"),
                        "model_number": record.get("model_number"),
                        "product_id": record.get("product_id"),
                        "product_name": record.get("product_name"),
                        "brand_id": record.get("brand_id"),
                        "brand_name": record.get("brand_name"),
                        "product_url": record.get("product_url"),
                        "product_category": record.get("product_category")
                    })
                return {"results": results}

        except Exception as e:
            print(f"❌ Supabase keyword search error: {e}")

    # 🧠 Fall back to CLIP if no keyword matches or it's an image search
    if index_type not in index_map or not index_map[index_type]:
        return JSONResponse({"error": f"Invalid or missing index: {index_type}"}, status_code=500)

    try:
        if file:
            image_bytes = await file.read()
            image = PILImage.open(io.BytesIO(image_bytes)).convert("RGB")
            if index_type == "structure":
                image = image.convert("L").convert("RGB")
            image_tensor = preprocess(image).unsqueeze(0).to(device)
            with torch.no_grad():
                query_features = model.encode_image(image_tensor)
        else:
            text_tokens = clip.tokenize([text]).to(device)
            with torch.no_grad():
                query_features = model.encode_text(text_tokens)

        query = query_features.cpu().numpy().astype(np.float32)
        query /= np.linalg.norm(query, axis=1, keepdims=True)

    except Exception as e:
        return JSONResponse({"error": f"Failed to compute features: {e}"}, status_code=500)

    index = index_map[index_type]
    D, I = index.search(query, top_k)
    id_map = id_maps[index_type]

    image_ids, scores = [], []
    for idx, i in enumerate(I[0]):
        score = float(D[0][idx])
        if score >= threshold and 0 <= i < len(id_map):
            image_ids.append(id_map[i])
            scores.append(score)

    # Metadata fetch
    variant_data = []
    if image_ids:
        def chunk_list(data, size):
            for i in range(0, len(data), size):
                yield data[i:i + size]

        for chunk in chunk_list(image_ids, 50):
            try:
                response = (
                    supabase.table("product_image_metadata")
                    .select("*")
                    .in_("image_id", chunk)
                    .execute()
                )
                if response.data:
                    variant_data.extend(response.data)
            except APIError as e:
                print(f"❌ Metadata fetch error: {e}")
                continue

    # Build final results
    for idx, img_id in enumerate(image_ids):
        score = scores[idx]
        match = next((item for item in variant_data if item["image_id"] == img_id), None)
        if match:
            results.append({
                "image_id": img_id,
                "image_path": match.get("image_url", "N/A"),
                "score": round(score, 4),
                "variant_id": match.get("variant_id"),
                "variant_name": match.get("variant_name"),
                "model_number": match.get("model_number"),
                "product_id": match.get("product_id"),
                "product_name": match.get("product_name"),
                "brand_id": match.get("brand_id"),
                "brand_name": match.get("brand_name"),
                "product_url": match.get("product_url"),
                "product_category": match.get("product_category")
            })

    results.sort(key=lambda x: x['score'], reverse=True)
    return {"results": results}

# Entry point for local testing
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
