FROM oven/bun:1.3

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json index.ts ./
COPY src ./src

ENV PORT=8787 \
    CURSOR_AUTH_FILE=/data/auth.json \
    CURSOR_CACHE_DIR=/data/cache

RUN mkdir -p /data/cache \
    && chown -R bun:bun /app /data

USER bun

EXPOSE 8787

CMD ["bun", "run", "index.ts"]
