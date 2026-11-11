FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-venv \
    ffmpeg \
    curl \
    git \
    unzip \
    procps \
    ca-certificates \
    libatomic1 \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp uses Deno to solve modern YouTube JavaScript challenges.
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh \
    && deno --version

# Install the matching BgUtils PO Token generator for YouTube only.
RUN git clone --depth 1 --branch 2.0.2 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/bgutil-ytdlp-pot-provider \
    && cd /opt/bgutil-ytdlp-pot-provider/server \
    && npm ci \
    && npx tsc

COPY package*.json ./

RUN npm install --legacy-peer-deps

COPY requirements.txt ./

RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir --upgrade "scrapling[fetchers]" \
    && python -c "from scrapling.fetchers import StealthyFetcher; print('StealthyFetcher import OK')" \
    && scrapling install \\\n    && patchright install chromium

COPY . .

RUN npm run build

ENV YTDLP_POT_PROVIDER_HOME=/opt/bgutil-ytdlp-pot-provider/server
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["npm", "start"]
