# Start from PyTorch base image (already has torch 2.1.2 installed)
FROM pytorch/pytorch:2.1.2-cpu

# Avoids writing pyc files & enables unbuffered output
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Install system dependencies (if any are needed later)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy only requirements first to leverage Docker layer caching
COPY requirements.txt /tmp/requirements.txt

# Install Python dependencies
# Note: torch is already in the base image, so no need to reinstall
RUN pip install --upgrade pip \
 && pip install faiss-cpu==1.7.4 \
 && pip install -r /tmp/requirements.txt

# Copy the rest of the application code
COPY . /app

# Expose the port FastAPI will run on
EXPOSE 8000

# Run the FastAPI app
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
