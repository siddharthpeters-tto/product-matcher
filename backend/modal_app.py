import modal
from modal import App, Image, Secret
import os, io, json
import faiss
import numpy as np
from PIL import Image as PILImage # Renamed to avoid conflict with modal.Image
from fastapi import FastAPI, UploadFile, File, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import torch
import clip
from dotenv import load_dotenv
from supabase import create_client
from postgrest.exceptions import APIError # Corrected import path for APIError

# Import the shared image definition
from lens_image import lens_image

# Updated: Use modal.NetworkFileSystem.from_name for the NFS volume
nfs = modal.NetworkFileSystem.from_name("faiss-index-storage", create_if_missing=False)

app = App("search-app", image=lens_image, secrets=[Secret.from_name("supabase-creds")])

@app.function(network_file_systems={"/data": nfs}, gpu="A10G")
@modal.asgi_app()
def fastapi_app():
    load_dotenv()
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model, preprocess = clip.load("ViT-B/32", device=device)
    supabase = create_client(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY"))

    index_map = {}
    id_maps = {}
    for mode in ["color", "structure", "combined"]:
        index_path = f"/data/clip_{mode}.index"
        id_map_path = f"/data/id_map_{mode}.json"
        try:
            # Check if index files exist before trying to load
            if not os.path.exists(index_path) or not os.path.exists(id_map_path):
                print(f"Warning: Index files for {mode} not found at {index_path} or {id_map_path}. "
                      "Please ensure the build_index.py job has completed successfully.")
                # You might want to raise an error or handle this more gracefully in production
                continue

            index_map[mode] = faiss.read_index(index_path)
            with open(id_map_path, "r") as f:
                id_maps[mode] = json.load(f)
            print(f"Successfully loaded {mode} index.")
        except Exception as e:
            print(f"Error loading {mode} index: {e}")
            # Handle cases where index loading fails (e.g., file corruption, empty)
            continue

    api_app = FastAPI() # Renamed to avoid conflict with modal.App

    api_app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"], # Adjust this in production for security
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @api_app.post("/search")
    async def search(
        file: UploadFile = File(None), # Make file optional for text search
        text: str = Query(None), # Add text query parameter
        index_type: str = Query("color"),
        threshold: float = Query(0.75),
        top_k: int = Query(20)
    ):
        if not file and not text:
            return JSONResponse({"error": "Either 'file' or 'text' must be provided."}, status_code=400)

        if index_type not in index_map:
            return JSONResponse({"error": f"Invalid index_type: {index_type}"}, status_code=400)

        if not index_map[index_type]:
             return JSONResponse({"error": f"Index for {index_type} is not loaded or available."}, status_code=500)

        query_features = None
        if file:
            image_bytes = await file.read()
            image = PILImage.open(io.BytesIO(image_bytes)).convert("RGB")
            if index_type == "structure":
                image = image.convert("L").convert("RGB")
            image_tensor = preprocess(image).unsqueeze(0).to(device)
            with torch.no_grad():
                query_features = model.encode_image(image_tensor)
        elif text:
            text_tokens = clip.tokenize([text]).to(device)
            with torch.no_grad():
                query_features = model.encode_text(text_tokens)

        if query_features is None:
            return JSONResponse({"error": "Failed to generate query features."}, status_code=500)

        query_features /= query_features.norm(dim=-1, keepdim=True)
        query = query_features.cpu().numpy().astype(np.float32)

        faiss.normalize_L2(query)
        index = index_map[index_type]
        D, I = index.search(query, top_k)
        id_map = id_maps[index_type]

        image_ids = [id_map[i] for i in I[0] if D[0][I[0].tolist().index(i)] >= threshold] # Filter by threshold
        scores = [float(s) for s in D[0].tolist() if s >= threshold] # Filter scores

        # Fetch metadata for filtered results
        variant_data = []
        if image_ids: # Only fetch if there are matching IDs after thresholding
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

        results = []
        for idx, img_id in enumerate(image_ids):
            score = scores[idx] # Use the already filtered score
            match = next((item for item in variant_data if item["id"] == img_id), None)
            
            if match: # Only add if metadata was found
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
        
        # Sort results by score in descending order
        results.sort(key=lambda x: x['score'], reverse=True)

        return {"results": results}

    return api_app
