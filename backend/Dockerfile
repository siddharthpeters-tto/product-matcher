# Start from PyTorch base image (already has torch 2.1.2 installed, CPU only, Python 3.10)
FROM pytorch/pytorch:2.1.2-cpu-py3.10

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy requirements first to enable Docker layer caching
COPY requirements.txt /tmp/requirements.txt

# Install dependencies (torch is preinstalled in base image)
RUN pip install --upgrade pip \
 && pip install faiss-cpu==1.7.4 \
 && pip install -r /tmp/requirements.txt

# Copy application code
COPY . /app

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
