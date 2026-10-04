FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
RUN mkdir -p /data && chown node:node /data
USER node
ENV HOST=0.0.0.0 PORT=3000 DATA_DIR=/data BEHIND_PROXY=1
EXPOSE 3000
VOLUME ["/data"]
CMD ["node", "--no-warnings=ExperimentalWarning", "src/server.js"]
