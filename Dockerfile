# ── Stage 1: Build React + Vite Frontend ─────────────────────────
FROM node:22-bookworm-slim AS frontend-builder
WORKDIR /build/client

COPY client/package*.json ./
RUN npm ci

COPY client/ ./
RUN npm run build

# ── Stage 2: Build Node.js Native Dependencies ───────────────────
FROM node:22-bookworm-slim AS backend-builder
WORKDIR /build/server

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY server/package*.json ./
RUN npm ci --omit=dev

# ── Stage 3: Production Runner ──────────────────────────────────
FROM node:22-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Copy node_modules & server source
COPY --from=backend-builder /build/server/node_modules ./server/node_modules
COPY server/ ./server/

# Copy compiled React frontend
COPY --from=frontend-builder /build/client/dist ./client/dist

# Ensure data and filestore directories exist
RUN mkdir -p /app/server/data /app/filestore

WORKDIR /app/server
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "src/index.js"]
