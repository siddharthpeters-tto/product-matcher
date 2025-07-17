import modal

app = modal.App(name="lens-image-app")

lens_image = (
    modal.Image.debian_slim()
    .apt_install("git")
    .pip_install(
        "faiss-cpu", "torch", "numpy", "ftfy", "regex", "tqdm", "requests",
        "Pillow", "supabase", "python-dotenv", "fastapi", "python-multipart"
    )
    .pip_install("git+https://github.com/openai/CLIP.git")
)

@app.function(image=lens_image)
def dummy():
    pass