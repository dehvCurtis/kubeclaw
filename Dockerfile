ARG SERVICE_VERSION=0.1.0

# --- Builder ---
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# --- Runtime ---
FROM node:22-alpine

ARG SERVICE_VERSION
LABEL org.opencontainers.image.version="${SERVICE_VERSION}"

RUN addgroup -g 1000 node 2>/dev/null || true \
 && adduser -u 1000 -G node -s /bin/sh -D node 2>/dev/null || true \
 && mkdir -p /home/node/.openclaw \
 && chown -R node:node /home/node/.openclaw

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY src ./src
COPY package.json ./

USER node

EXPOSE 18789 18790

CMD ["node", "src/gateway.js"]
