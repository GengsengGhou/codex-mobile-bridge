FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && mkdir -p /data && chown node:node /data
COPY hub ./hub
COPY public ./public
COPY src/static-assets.mjs ./src/static-assets.mjs
COPY scripts/read-secret.mjs ./scripts/read-secret.mjs
ENV NODE_ENV=production HUB_DB_PATH=/data/hub.sqlite PORT=3000
USER node
EXPOSE 3000
CMD ["node", "hub/server.mjs"]
