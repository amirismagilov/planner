FROM python:3.11-slim

# Create non-root user
RUN useradd -m -u 1000 planner

WORKDIR /app

# Install system dependencies without interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Upgrade pip
RUN pip install --no-cache-dir --upgrade pip

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# Change ownership and switch to non-root user
RUN chown -R planner:planner /app
USER planner

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
