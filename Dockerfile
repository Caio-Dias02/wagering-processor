# Bun executa TypeScript direto: não há etapa de build, só instalar e copiar o código.

FROM oven/bun:1.4.2 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.2
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
USER bun
EXPOSE 3000
# O Nest trata SIGTERM (enableShutdownHooks): termina o que está em andamento antes de sair.
CMD ["bun", "src/main.ts"]
