from modal import Image

# Shared Modal Image definition for the backend application
lens_image = (
    Image.debian_slim()
    .apt_install("git")
    .pip_install(
        "faiss-cpu", "torch", "numpy", "ftfy", "regex", "tqdm", "requests",
        "Pillow", "supabase", "python-dotenv", "fastapi", "uvicorn", "clip",
        "postgrest-py" # Added postgrest-py for APIError
    )
    .pip_install("git+https://github.com/openai/CLIP.git") # Re-install CLIP from GitHub to be safe
)
