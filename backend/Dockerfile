FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS dependencies
WORKDIR /app/backend
RUN apk --timeout 60 add --no-cache poppler-utils
COPY backend/package*.json ./
RUN npm ci --omit=dev

FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85
WORKDIR /app/backend
RUN apk --timeout 60 update \
    && apk --timeout 60 upgrade \
    && apk --timeout 60 add poppler poppler-data font-noto-cjk \
    && rm -rf /var/cache/apk/* \
    && rm -rf /usr/local/lib/node_modules /opt/yarn-* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=dependencies /app/backend/node_modules ./node_modules
# These three tools use Poppler's Splash renderer; pdftocairo and its Cairo/X11 dependencies are unused.
COPY --from=dependencies /usr/bin/pdfinfo /usr/bin/pdftotext /usr/bin/pdftoppm /usr/bin/
COPY backend/package*.json ./
COPY backend/src ./src
COPY shared /app/shared
COPY backend/scripts ./scripts
RUN mkdir -p /app/data /app/backups && chown node:node /app/data /app/backups
USER node
ENV HOST=0.0.0.0 PORT=3001 DATABASE_PATH=/app/data/shopmate.sqlite
ARG VCS_REF=local
ENV VCS_REF=$VCS_REF
LABEL org.opencontainers.image.source="https://github.com/W205614/ShopMate-AI" \
      org.opencontainers.image.revision=$VCS_REF
HEALTHCHECK --interval=15s --timeout=3s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
EXPOSE 3001
CMD ["node", "--import", "tsx", "src/index.ts"]
