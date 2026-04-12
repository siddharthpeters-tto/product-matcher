FROM python:3.10-slim

WORKDIR /app

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /tmp/requirements.txt

RUN pip install --no-cache-dir "pip<26" "setuptools<81" wheel \
 && pip install --no-cache-dir -r /tmp/requirements.txt --extra-index-url https://download.pytorch.org/whl/cpu

RUN python -c "import clip; clip.load('ViT-B/32', device='cpu')"

COPY . /app

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]