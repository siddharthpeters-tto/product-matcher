import clip
import torch
from PIL import Image
import requests
import numpy as np
from io import BytesIO
import math
import hashlib

# -------- CONFIG --------
device = "cuda" if torch.cuda.is_available() else "cpu"

# Local image path (e.g., downloaded from frontend upload)
#local_image_path = "volt677rm2.jpg"

# Load local image as bytes (simulating what frontend sends)
with open("volt_677rm_2.jpg", "rb") as f:
    local_image_bytes = f.read()

# Hash for debug
local_hash = hashlib.sha256(local_image_bytes).hexdigest()
print(f"🔍 SHA256 of local image bytes: {local_hash}")

# Convert to PIL from bytes like FastAPI does
local_image = Image.open(BytesIO(local_image_bytes))

# Supabase image URL (exact same image you indexed)
supabase_image_url = "https://pub-8c00fab3b56d4e9ba0b1d6f9054cf61d.r2.dev/volt_677rm_2.jpg"
response = requests.get(supabase_image_url)
supabase_bytes = response.content
supabase_hash = hashlib.sha256(supabase_bytes).hexdigest()
print(f"🔍 SHA256 of Supabase image bytes: {supabase_hash}")


# ------------------------

# Load CLIP
model, preprocess = clip.load("ViT-B/32", device=device)

def embed_image(pil_image):
    pil_image = pil_image.convert("RGB")
    image_tensor = preprocess(pil_image).unsqueeze(0).to(device)
    with torch.no_grad():
        embedding = model.encode_image(image_tensor).cpu().numpy().astype(np.float32)
        embedding /= np.linalg.norm(embedding, axis=1, keepdims=True)
    return embedding[0]

# Load local image
local_embed = embed_image(local_image)

# Load Supabase image
response = requests.get(supabase_image_url)
supabase_image = Image.open(BytesIO(response.content))
supabase_embed = embed_image(supabase_image)

# Cosine similarity
cos_sim = float(np.dot(local_embed, supabase_embed))
angle = math.degrees(math.acos(np.clip(cos_sim, -1.0, 1.0)))

print("\n✅ Comparison Result:")
print(f"Cosine Similarity: {cos_sim:.6f}")
print(f"Angle Between Vectors: {angle:.2f}°")
print(f"\nLocal vector head: {local_embed[:5]}")
print(f"Supabase vector head: {supabase_embed[:5]}")
