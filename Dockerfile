# syntax=docker/dockerfile:1.7

# ---- builder ----------------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime ---------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    CLIO_TRANSPORT=http \
    CLIO_HTTP_HOST=0.0.0.0 \
    CLIO_HTTP_PORT=8765 \
    CLIO_STATE_DIR=/state

# State directory — mount an Azure Files share (or named volume locally) here
# for persistent audit log + token blob.
RUN mkdir -p /state && chown -R node:node /state /app
VOLUME ["/state"]

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/build ./build
COPY --from=builder --chown=node:node /app/package.json ./package.json

USER node
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8765/healthz >/dev/null || exit 1

ENTRYPOINT ["node", "build/index.js"]
CMD ["--http"]
