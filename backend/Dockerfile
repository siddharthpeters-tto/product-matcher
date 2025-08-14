# Start from Python 3.10 slim image
FROM python:3.10-slim

# Avoid .pyc files and enable unbuffered logging
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Set work directory
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    git \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements.txt separately for Docker cache
COPY requirements.txt /tmp/requirements.txt

# Upgrade pip and install heavy dependencies first (cached layer)
# Install CPU-only PyTorch & torchvision from official index
RUN pip install --upgrade pip \
 && pip cache purge \
 && pip install torch==2.1.2+cpu torchvision==0.16.2+cpu \
        --extra-index-url https://download.pytorch.org/whl/cpu \
 && pip install faiss-cpu==1.7.4 \
 && pip install -r /tmp/requirements.txt \
        --extra-index-url https://download.pytorch.org/whl/cpu

# Copy application code
COPY . /app

# Expose port
EXPOSE 8000

# Start app
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
