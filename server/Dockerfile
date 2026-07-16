# Multi-stage: native deps (better-sqlite3, sharp) need a build toolchain,
# but the toolchain itself shouldn't ship in the final image.
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# better-sqlite3 compiles a native binding from source; sharp fetches a
# prebuilt libvips but still needs node-gyp's toolchain present during install.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY . .

# data/ is a runtime volume (SQLite db), not part of the image.
RUN mkdir -p data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "src/index.js"]
