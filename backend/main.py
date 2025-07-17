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
from dotenv import load_dotenv
from supabase import create_client
from postgrest.exceptions import APIError

load_dotenv()
device = "cuda" if torch.cuda.is_available() else "cpu"
model, preprocess = clip.load("ViT-B/32", device=device)
supabase = create_client(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY"))

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

# Load FAISS indexes and ID maps from Supabase
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
    index_type: str = Query("color"),
    threshold: float = Query(0.75),
    top_k: int = Query(20)
):
    if not file and not text:
        return JSONResponse({"error": "Either 'file' or 'text' must be provided."}, status_code=400)

    if index_type not in index_map or not index_map[index_type]:
        return JSONResponse({"error": f"Invalid or missing index: {index_type}"}, status_code=500)

    # Generate query vector
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

        query_features /= query_features.norm(dim=-1, keepdim=True)
        query = query_features.cpu().numpy().astype(np.float32)
        faiss.normalize_L2(query)
    except Exception as e:
        return JSONResponse({"error": f"Failed to compute features: {e}"}, status_code=500)

    # Search in FAISS
    index = index_map[index_type]
    D, I = index.search(query, top_k)
    id_map = id_maps[index_type]

    image_ids = [id_map[i] for i in I[0] if D[0][I[0].tolist().index(i)] >= threshold]
    scores = [float(s) for s in D[0].tolist() if s >= threshold]

    # Fetch metadata from Supabase
    variant_data = []
    if image_ids:
        def chunk_list(data, size):
            for i in range(0, len(data), size):
                yield data[i:i + size]

        for chunk in chunk_list(image_ids, 50):
            try:
                response = (
                    supabase.table("product_images")
                    .select("""
                        id,
                        image_url,
                        product_variants(
                            id,
                            name,
                            model_number,
                            products(
                                id,
                                name,
                                brands(
                                    id,
                                    name
                                )
                            )
                        )
                    """)
                    .in_("id", chunk)
                    .execute()
                )
                if response.data:
                    variant_data.extend(response.data)
            except APIError as e:
                print(f"❌ Metadata fetch error: {e}")
                continue

    # Build result
    results = []
    for idx, img_id in enumerate(image_ids):
        score = scores[idx]
        match = next((item for item in variant_data if item["id"] == img_id), None)
        if match:
            variant = match.get("product_variants")
            product = variant.get("products") if variant else None
            brand = product.get("brands") if product else None

            results.append({
                "image_id": img_id,
                "image_path": match.get("image_url", "N/A"),
                "score": round(score, 4),
                "variant_id": variant.get("id") if variant else None,
                "variant_name": variant.get("name") if variant else None,
                "model_number": variant.get("model_number") if variant else None,
                "product_id": product.get("id") if product else None,
                "product_name": product.get("name") if product else None,
                "brand_id": brand.get("id") if brand else None,
                "brand_name": brand.get("name") if brand else None,
            })

    results.sort(key=lambda x: x['score'], reverse=True)
    return {"results": results}

# Entry point if running locally
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
