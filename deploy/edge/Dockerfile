FROM golang:1.27.3@sha256:d200d2dd76b03a99b52651fd1325aff7dcd35422c35c01bac56571b0507f3deb AS build
ENV CGO_ENABLED=0 GOTOOLCHAIN=local
WORKDIR /src
COPY deploy/edge/go.mod deploy/edge/go.sum ./
RUN --mount=type=cache,id=shopmate-edge-go-mod,target=/go/pkg/mod go mod download
COPY deploy/edge/main.go ./
RUN --mount=type=cache,id=shopmate-edge-go-mod,target=/go/pkg/mod --mount=type=cache,id=shopmate-edge-go-build,target=/root/.cache/go-build \
    go mod verify && \
    test -z "$(gofmt -l main.go)" && \
    go build -mod=readonly -trimpath -ldflags="-s -w" -o /out/caddy . && \
    go version -m /out/caddy > /out/build-info.txt && \
    go list -deps -f '{{if .Module}}{{.Module.Path}} {{.Module.Version}} {{.Module.Dir}}{{end}}' . | sort -u > /out/modules.txt && \
    while read -r module version directory; do \
      [ -n "$directory" ] || continue; \
      target="/out/licenses/$module@$version"; mkdir -p "$target"; \
      for file in "$directory"/LICENSE* "$directory"/NOTICE* "$directory"/COPYING* "$directory"/COPYRIGHT* "$directory"/PATENTS* "$directory"/AUTHORS*; do \
        if [ -f "$file" ]; then cp "$file" "$target/"; fi; \
      done; \
    done < /out/modules.txt && \
    mkdir -p /out/licenses/go && cp /usr/local/go/LICENSE /usr/local/go/PATENTS /out/licenses/go/
COPY LICENSE /out/licenses/shopmate-ai/LICENSE

FROM caddy:2.11.9-alpine@sha256:71d41fe4b1ae92a058abc87afe614178b996d8a6b96d0f4c71ae30606e5927e3
RUN apk add --no-cache --upgrade zlib=1.4-r0
COPY --from=build /out/caddy /usr/bin/caddy
COPY --from=build /out/licenses/ /usr/share/licenses/shopmate-edge/
COPY --from=build /out/build-info.txt /out/modules.txt /usr/share/caddy/
ARG VCS_REF=local
LABEL org.opencontainers.image.title="ShopMate-AI dependency-updated Caddy edge" \
      org.opencontainers.image.source="https://github.com/W205614/ShopMate-AI" \
      org.opencontainers.image.revision=$VCS_REF
