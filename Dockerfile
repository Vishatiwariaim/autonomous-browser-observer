# ABO Observer — production / LAN deploy
FROM node:22-bookworm-slim

WORKDIR /app

# Copy workspace manifests first for better layer caching
COPY package.json package-lock.json ./
COPY ai/package.json ./ai/
COPY controller/package.json ./controller/
COPY cursor-bridge/package.json ./cursor-bridge/
COPY mcp-observer/package.json ./mcp-observer/
COPY demo-app/package.json ./demo-app/
COPY observer/package.json ./observer/
COPY extension/package.json ./extension/

RUN npm install --omit=dev=false

COPY . .

ENV NODE_ENV=production
ENV OBSERVER_HOST=0.0.0.0
ENV OBSERVER_PORT=3847
ENV OBSERVER_DATA_DIR=/data
ENV ABO_ACP_MODE=mock
ENV ABO_AUTOPILOT=0

VOLUME ["/data"]
EXPOSE 3847

WORKDIR /app/observer
CMD ["npx", "tsx", "src/server/index.ts"]
