FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
# /data is normally a bind mount; docker-compose.yml sets the user via PUID/PGID so it can write there.
RUN mkdir -p /data && chmod 777 /data
USER node
ENV HOST=0.0.0.0 PORT=3000 DATA_DIR=/data BEHIND_PROXY=1
EXPOSE 3000
VOLUME ["/data"]
CMD ["node", "--no-warnings=ExperimentalWarning", "src/server.js"]
