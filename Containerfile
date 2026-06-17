FROM docker.io/node:26-alpine AS builder

WORKDIR /build

COPY package.json package-lock.json tsconfig.json ./
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN apk add --no-cache python3 make g++ && \
    npm ci && \
    cd frontend && npm ci

COPY src/ ./src/
COPY frontend/ ./frontend/
RUN npm run build && \
    npm prune --omit=dev && \
    rm -rf /build/frontend/node_modules

FROM docker.io/node:26-alpine

RUN apk add --no-cache libstdc++ dumb-init curl

WORKDIR /app

COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/dist/ ./dist/
COPY --from=builder /build/frontend/dist/ ./frontend/dist/

RUN npm cache clean --force

# Copy Lightpanda binary from builder stage (downloaded during npm ci)
COPY --from=builder /root/.cache/lightpanda-node /home/node/.cache/lightpanda-node
RUN chown -R node:node /home/node/.cache/lightpanda-node

RUN mkdir -p /app/db && chown node:node /app/db

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:3000/api/health || exit 1

VOLUME /scenarios
VOLUME /app/db
VOLUME /app/settings

USER node

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js", "server", "--scenarios-dir", "/scenarios", "--db", "/app/db/scenarii.db"]
