# Distributed Wagering Processor

Serviço financeiro que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) vindas de provedores de jogos, pela API HTTP ou por fila SQS, e continua correto com mensagens **duplicadas**, **fora de ordem** e processadas por **várias instâncias** ao mesmo tempo.

Solução do [desafio técnico da Jungle Gaming](https://github.com/junglegaming/backend-challenge). As decisões, trade-offs e limitações estão em **[ARCHITECTURE.md](ARCHITECTURE.md)**.

**Stack:** Bun · TypeScript (strict) · NestJS · PostgreSQL 17 · MikroORM 6 · SQS (LocalStack 4.4) · Docker Compose · Prometheus (prom-client)

## Destaques

- **Dinheiro sem `number`**: centavos em `bigint` no domínio, string `"25.00"` nos contratos, `numeric(19,2)` no banco.
- **Concorrência**: lock pessimista por wallet (`SELECT ... FOR UPDATE`) + checagem de versão; correto com N instâncias (testado com 3 processos reais, um deles morto à força sob carga).
- **Idempotência persistente**: `Idempotency-Key` + hash canônico do payload; replay devolve o resultado original, inclusive o saldo observado; payload diferente com a mesma key é 409.
- **Ledger auditável e imutável**: append-only por trigger; o banco confere a aritmética de cada lançamento.
- **Inbox + transactional outbox**: efeito financeiro, inbox e eventos na mesma transação; publicação at-least-once com `FOR UPDATE SKIP LOCKED`.
- **Referências fora de ordem**: `PENDING_REFERENCE` + worker com backoff exponencial.
- **Observabilidade**: logs JSON com correlation id, métricas Prometheus, readiness, reconciliação.

## Requisitos

- [Bun](https://bun.com) 1.4+
- Docker com Docker Compose

## Como rodar

### Tudo em containers

```bash
docker compose --profile app up -d --build                 # 1 instância em http://localhost:3000
docker compose --profile app up -d --build --scale app=3   # 3 instâncias: portas 3000, 3001, 3002
```

O serviço `migrate` aplica as migrations uma vez e termina; as instâncias do `app` só sobem depois dele (várias réplicas nunca migram ao mesmo tempo). Cada instância serve a API **e** roda o consumer SQS, o publisher da outbox e o worker de referências pendentes. `docker compose --profile app stop app` desliga de forma graciosa: termina o que está em andamento e sai com código 0.

### Desenvolvimento local

```bash
bun install
docker compose up -d        # só Postgres 17 + LocalStack (as filas SQS são criadas automaticamente)
bun run db:migrate          # aplica as migrations
bun run dev                 # API em http://localhost:3000 (com watch)
```

Sem `--profile app`, o compose sobe só as dependências: é o modo usado pelo desenvolvimento e pelos testes (um app em container consumiria a mesma fila que os testes). Para mais instâncias locais, suba processos em outras portas:

```bash
PORT=3001 bun start         # bash
$env:PORT=3001; bun start   # PowerShell
```

## Testes

Com o `docker compose up -d` rodando (**sem** `--profile app`: um app em container competiria com os testes pela mesma fila):

```bash
bun test              # tudo (~35 s): unidade, integração, e2e HTTP e 3 instâncias
bun test test/unit    # só unidade (não precisa de Docker)
bun run typecheck
```

Os testes usam Postgres e LocalStack **reais** — nenhum mock de banco ou fila. Todo teste confere a invariante `saldo da wallet == saldo reconstruído pelo ledger`. O teste de múltiplas instâncias sobe processos `bun src/main.ts` nas portas 3101–3104. O mapa "exigência do desafio → teste" está no [ARCHITECTURE.md §16](ARCHITECTURE.md#16-testes).

## Comandos

| Comando | O que faz |
|---|---|
| `bun run dev` | API com watch |
| `bun start` | API sem watch |
| `bun test` | todos os testes |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run db:migrate` | aplica migrations pendentes |
| `bun run db:rollback` | desfaz a última migration |
| `bun run db:migration:create` | gera migration a partir das entidades |
| `bun run db:migration:blank` | cria migration vazia (SQL manual) |

## API

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/wallets` | cria wallet (saldo inicial > 0 gera `OPENING` + crédito no ledger) |
| `GET` | `/wallets/:walletId` | saldo e versão |
| `GET` | `/wallets/:walletId/ledger?cursor=&limit=50` | ledger paginado (cursor opaco e estável) |
| `POST` | `/wallets/:walletId/reconciliation` | saldo guardado × saldo recalculado pelo ledger |
| `POST` | `/wagering/transactions` | submete transação (header `Idempotency-Key` obrigatório) |
| `GET` | `/wagering/transactions/:transactionId` | transação pelo id interno |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | transação pelo id do provedor |
| `GET` | `/health/live` · `/health/ready` | liveness · readiness (Postgres + SQS) |
| `GET` | `/metrics` | métricas Prometheus |

Status: `200` processada · `202` aguardando referência · `400` payload inválido · `409` conflito de idempotência / wallet duplicada · `422` rejeição de negócio (com `failureCode`) · `503` falha transitória (reenviar com a mesma key). Detalhes no [ARCHITECTURE.md §9](ARCHITECTURE.md#9-api-http-e-status).

### Exemplo

```bash
# 1. criar wallet
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

# 2. apostar (troque WALLET_ID pelo id devolvido acima)
curl -s -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123",
       "playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"WALLET_ID",
       "roundId":"round-987","gameId":"fortune-chimp","kind":"BET",
       "money":{"amount":"25.00","currency":"BRL"}}'
# → {"transactionId":"…","status":"PROCESSED","balance":{"amount":"975.00","currency":"BRL"},"failureCode":null,"idempotentReplay":false}

# repetir o mesmo comando devolve o mesmo resultado com "idempotentReplay": true
```

### Enviando pela fila

```bash
docker exec wagering-localstack awslocal sqs send-message \
  --queue-url http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/wager-transactions.fifo \
  --message-group-id WALLET_ID --message-deduplication-id msg-123 \
  --message-body '{"messageId":"msg-123","type":"WagerTransactionRequested","occurredAt":"2026-07-29T15:00:00.000Z",
    "data":{"providerId":"provider-a","externalTransactionId":"transaction-124","idempotencyKey":"provider-a:transaction-124",
    "playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"WALLET_ID","roundId":"round-987",
    "gameId":"fortune-chimp","kind":"BET","money":{"amount":"10.00","currency":"BRL"}}}'
```

Filas (criadas por `docker/localstack/init-sqs.sh`): `wager-transactions.fifo` (entrada; DLQ após 5 recebimentos), `wager-transactions-dlq.fifo` e `wagering-events.fifo` (eventos publicados pela outbox).

## Configuração

Todas as variáveis têm padrão para o ambiente local do `docker compose`.

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3000` | porta HTTP |
| `DATABASE_URL` | `postgresql://wagering:wagering@localhost:5432/wagering` | Postgres |
| `SQS_ENDPOINT` | `http://localhost:4566` | endpoint SQS (LocalStack) |
| `AWS_REGION` | `us-east-1` | região |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | `test` / `test` | credenciais (LocalStack aceita qualquer uma) |
| `SQS_INPUT_QUEUE` | `wager-transactions.fifo` | fila de entrada |
| `SQS_DLQ` | `wager-transactions-dlq.fifo` | dead-letter queue |
| `SQS_EVENTS_QUEUE` | `wagering-events.fifo` | fila de eventos de integração |
| `SQS_VISIBILITY_TIMEOUT_SECONDS` | padrão da fila (30) | invisibilidade de uma mensagem recebida |
| `SQS_CONSUMER_ENABLED` | `true` | liga o consumer |
| `OUTBOX_WORKER_ENABLED` | `true` | liga o publisher da outbox |
| `OUTBOX_POLL_INTERVAL_MS` | `500` | espera da outbox quando não há pendentes |
| `PENDING_REFERENCE_WORKER_ENABLED` | `true` | liga o worker de referências pendentes |
| `PENDING_REFERENCE_POLL_INTERVAL_MS` | `1000` | espera do worker quando não há pendentes |
| `LOG_LEVEL` | `info` | `debug` · `info` · `warn` · `error` · `silent` |

## Estrutura

```
src/
  domain/            Money, Wallet, WalletLedgerEntry, WagerTransaction (puro: sem Nest, sem ORM)
  application/       casos de uso, portas, eventos, outbox/inbox, validação de entrada
  infrastructure/
    database/        entidades (EntitySchema), mappers, repositórios, unit of work, migrations
    messaging/       cliente SQS, publisher de eventos, consumer
    workers/         loops da outbox, do consumer e das referências pendentes
    observability/   logger JSON, métricas Prometheus
  http/              controllers, presenters, filtro de erros, auth guard
  health/            liveness e readiness
test/
  unit/  integration/  e2e/  multi-instance/
docker/localstack/   criação das filas
Dockerfile           imagem da aplicação (oven/bun, só dependências de produção)
```
