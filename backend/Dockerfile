FROM python:3.10-slim

# Install system dependencies
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt /tmp/requirements.txt

# Upgrade pip and install PyTorch + faiss first
RUN pip install --upgrade pip \
 && pip cache purge \
 && pip install torch==2.1.2+cpu torchvision==0.16.2+cpu faiss-cpu==1.7.4 \
     --extra-index-url https://download.pytorch.org/whl/cpu \
 && pip install -r /tmp/requirements.txt \
 && pip freeze > /tmp/requirements.lock \
 && cat /tmp/requirements.lock

COPY modal_faiss_builder /app/modal_faiss_builder
COPY . /app

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
