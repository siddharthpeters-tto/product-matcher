from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
import os
import tempfile
import base64

import imageextract

app = FastAPI()

frontend_url = os.getenv("FRONTEND_URL", "")
railway_static_url = os.getenv("RAILWAY_STATIC_URL", "")

allowed_origins = [
    "http://localhost:3000",
    "http://localhost:5173",
]

if frontend_url:
    allowed_origins.append(frontend_url)

if railway_static_url:
    allowed_origins.append(f"https://{railway_static_url}")

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
def health():
    return {"ok": True}

@app.post("/extract-pdf-images")
async def extract_pdf_images(file: UploadFile = File(...)):
    suffix = os.path.splitext(file.filename)[1] if file.filename else ".pdf"

    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        contents = await file.read()
        tmp.write(contents)
        tmp_path = tmp.name

    try:
        extracted = imageextract.extract_dynamic(tmp_path)

        results = []
        for item in extracted:
            image_b64 = None
            image_path = item.get("image_path")

            if image_path and os.path.exists(image_path):
                with open(image_path, "rb") as img_file:
                    image_b64 = base64.b64encode(img_file.read()).decode("utf-8")

            results.append({
                "code": item.get("code"),
                "page": item.get("page"),
                "image_base64": image_b64,
            })

        return {"images": results}

    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)