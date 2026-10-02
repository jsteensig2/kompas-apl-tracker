# For hosting outside Render (any server with Docker). Data lives in the /data volume.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY core ./core
COPY server ./server
COPY public ./public
COPY scripts/reset-db.js ./scripts/reset-db.js
ENV NODE_ENV=production DB_FILE=/data/kompas-apl.db SEED_EXAMPLES=false PORT=3000
VOLUME /data
EXPOSE 3000
CMD ["npm", "start"]
