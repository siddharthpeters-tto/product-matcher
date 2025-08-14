# Use a slim Python image for smaller size
FROM python:3.10-slim

# Prevent Python from buffering stdout/stderr and avoid .pyc files
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1

# Install system dependencies needed for FAISS, Pillow, etc.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libopenblas-dev \
    libomp-dev \
    libjpeg-dev \
    zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

# Set work directory
WORKDIR /app

# Copy requirements first so dependency install can be cached
COPY requirements.txt .

# Upgrade pip and install dependencies
# This layer will be cached unless requirements.txt changes
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

# Copy only necessary files (excluding via .dockerignore)
COPY . .

# Expose the port your app runs on
EXPOSE 8000

# Start the API server
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
