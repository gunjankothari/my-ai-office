# The hub and the web app, as one service. Railway finds this file by itself.
FROM node:22-slim
WORKDIR /app

# Install first, so the layer is reused when only source files change.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/hub/package.json apps/hub/
COPY apps/host/package.json apps/host/
COPY apps/web/package.json apps/web/
RUN npm ci

COPY . .
RUN npm run build:web

# Railway sets PORT. The hub must listen on 0.0.0.0 to be reachable. The database goes on the volume mounted at /data.
ENV NODE_ENV=production \
    BIND_HOST=0.0.0.0 \
    WEB_DIR=/app/apps/web/dist \
    HUB_DB=/data/hub.db

# Runs as the image's default user: a Railway volume is not writable by a non-root user unless RAILWAY_RUN_UID=0 is set.
CMD ["node", "--import", "tsx", "apps/hub/src/main.ts"]
