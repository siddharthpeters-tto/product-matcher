# Use official slim Python 3.10 base image
FROM python:3.10-slim

# Environment variables for performance & cleanliness
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
 && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy only requirements.txt first to enable Docker layer caching
COPY requirements.txt /tmp/requirements.txt

# Install heavy dependencies (cached if requirements.txt unchanged)
RUN pip install --upgrade pip \
 && pip install torch==2.1.2 faiss-cpu==1.7.4 \
 && pip install -r /tmp/requirements.txt

# Copy the rest of the code
COPY . /app

# Expose FastAPI default port
EXPOSE 8000

# Start FastAPI
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
