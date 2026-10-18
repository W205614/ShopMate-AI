FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f
WORKDIR /app/backend
RUN apk add --no-cache poppler-utils poppler-data font-noto-cjk
COPY backend/package*.json ./
RUN npm ci --omit=dev
COPY backend/src ./src
COPY shared /app/shared
COPY backend/scripts ./scripts
RUN mkdir -p /app/data /app/backups && chown node:node /app/data /app/backups
USER node
ENV HOST=0.0.0.0 PORT=3001 DATABASE_PATH=/app/data/shopmate.sqlite
ARG VCS_REF=local
LABEL org.opencontainers.image.source="https://github.com/W205614/ShopMate-AI" \
      org.opencontainers.image.revision=$VCS_REF
HEALTHCHECK --interval=15s --timeout=3s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
EXPOSE 3001
CMD ["node", "--import", "tsx", "src/index.ts"]
