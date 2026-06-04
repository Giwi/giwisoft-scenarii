FROM docker.io/node:22-alpine AS builder

WORKDIR /build

COPY package.json package-lock.json tsconfig.json ./
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN apk add --no-cache python3 make g++ && \
    npm ci && \
    cd frontend && npm ci

COPY src/ ./src/
COPY frontend/ ./frontend/
RUN npm run build

FROM docker.io/node:22-alpine

RUN apk add --no-cache libstdc++ dumb-init

WORKDIR /app

COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/dist/ ./dist/
COPY --from=builder /build/frontend/dist/ ./frontend/dist/

RUN rm -rf node_modules/{typescript,@types/*,ts-node} && \
    npm cache clean --force

EXPOSE 3000

VOLUME /scenarios
VOLUME /app/db
VOLUME /app/settings

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js", "server", "--scenarios-dir", "/scenarios", "--db", "/app/db/scenarii.db"]
