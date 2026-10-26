FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
COPY public ./public
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
ENV HOST=127.0.0.1 PORT=8787 DATA_DIR=/app/data
EXPOSE 8787
CMD ["node", "src/main.js"]
