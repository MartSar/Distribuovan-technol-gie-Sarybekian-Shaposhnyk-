# Jeden obraz pre všetky uzly aj pre sync worker – líšia sa len konfiguráciou (NODE_ID, PEERS…).
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public

USER node
EXPOSE 3000

# Health check API kontajnera (overuje aj spojenie s databázou).
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["node", "src/server.js"]
