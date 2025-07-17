from modal import Image

# Shared Modal Image definition for the backend application
lens_image = (
    Image.debian_slim()
    .apt_install(
        "git",
        "libjpeg-dev",  # Required for JPEG support in Pillow
        "zlib1g-dev",   # Required for PNG support in Pillow
        "libpng-dev",   # Required for PNG support in Pillow
        "libtiff-dev",  # Required for TIFF support in Pillow
        "libfreetype6-dev", # Often needed for font rendering in Pillow
        "liblcms2-dev", # Color management support in Pillow
        "libwebp-dev",  # WebP image format support
    )
    .pip_install("Pillow") # Install Pillow separately and early
    .pip_install(
        "faiss-cpu",
        "torch", "numpy", "ftfy", "regex", "tqdm", "requests",
        "supabase", "python-dotenv", "fastapi", "uvicorn", "clip",
        "postgrest-py"
    )
    .pip_install("git+https://github.com/openai/CLIP.git") # Re-install CLIP from GitHub to be safe
)