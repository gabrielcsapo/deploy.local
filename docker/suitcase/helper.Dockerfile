# syntax=docker/dockerfile:1.7
FROM alpine:3.22

LABEL org.opencontainers.image.title="deploy.local suitcase volume helper" \
      org.opencontainers.image.description="Narrow helper for portable volume inspection and snapshots" \
      deploy.local.runtime.protocol="1"

RUN apk add --no-cache coreutils jq sqlite tar zstd
COPY docker/suitcase/helper-entrypoint.sh /usr/local/bin/suitcase-volume-helper
RUN chmod 0755 /usr/local/bin/suitcase-volume-helper

ENV DEPLOY_SUITCASE_RUNTIME_PROTOCOL=1
VOLUME ["/var/lib/deploy.local"]
ENTRYPOINT ["/usr/local/bin/suitcase-volume-helper"]
CMD ["help"]

