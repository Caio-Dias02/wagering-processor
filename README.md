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
- **Observabilidade**: logs JSON com correlation id, métricas Prometheus, readiness, reconciliação sob demanda e agendada (uma instância por ciclo, via lease no banco).
- **Teste de carga que confere o dinheiro**: `bun run test:load` mede throughput e latência **e** prova que, depois de milhares de transações concorrentes, duplicadas e fora de ordem, cada saldo bate centavo por centavo com as respostas.

## Requisitos

- [Bun](https://bun.com) 1.4+
- Docker com Docker Compose

## Como rodar

### Tudo em containers

```bash
docker compose --profile app up -d --build                 # 1 instância em http://localhost:3000
docker compose --profile app up -d --build --scale app=3   # 3 instâncias: portas 3000, 3001, 3002
```

O serviço `migrate` aplica as migrations uma vez e termina; as instâncias do `app` só sobem depois dele (várias réplicas nunca migram ao mesmo tempo). Cada instância serve a API **e** roda o consumer SQS, o publisher da outbox, o worker de referências pendentes e o agendador da reconciliação. `docker compose --profile app stop app` desliga de forma graciosa: termina o que está em andamento e sai com código 0.

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

Com o `docker compose up -d` rodando (**sem** `--profile app`) e **nenhuma** instância da aplicação no ar (nem `bun run dev`): os workers dela competiriam com os testes pela mesma fila e pelas mesmas linhas da outbox.

```bash
bun test              # tudo (~45 s): unidade, integração, e2e HTTP e 3 instâncias
bun test test/unit    # só unidade (não precisa de Docker)
bun run typecheck
```

Os testes usam Postgres e LocalStack **reais** — nenhum mock de banco ou fila. Todo teste confere a invariante `saldo da wallet == saldo reconstruído pelo ledger`. O teste de múltiplas instâncias sobe processos `bun src/main.ts` nas portas 3101–3104. O mapa "exigência do desafio → teste" está no [ARCHITECTURE.md §16](ARCHITECTURE.md#16-testes).

### Teste de carga

Bate numa aplicação **já rodando** e, além de medir, confere a correção no fim:

```bash
bun run dev                                    # ou: docker compose --profile app up -d --build
bun run test:load                              # 20 wallets, 2000 transações, 50 em paralelo

# 3 instâncias em container, mais carga
docker compose --profile app up -d --build --scale app=3
LOAD_TARGETS=http://localhost:3000,http://localhost:3001,http://localhost:3002 \
  LOAD_CONCURRENCY=150 LOAD_TRANSACTIONS=6000 bun run test:load
```

O tráfego mistura rodadas normais (`BET` → `WIN`/`LOSS`/`REFUND`/`ROLLBACK`), desfechos que chegam **antes** da aposta, `REFUND` e `ROLLBACK` da mesma `BET` ao mesmo tempo, 10% de reenvios duplicados em paralelo e wallets "quentes" (10% das wallets recebem metade das rodadas). No fim, o script confere:

- o saldo de cada wallet == saldo inicial + efeito de cada transação que a API respondeu como `PROCESSED` (em centavos `bigint`);
- a reconciliação (`saldo == ledger`) de cada wallet;
- nenhuma `BET` revertida duas vezes;
- cada par de duplicatas devolveu a mesma transação, com uma resposta marcada como replay;
- nenhuma transação ficou presa em `PENDING_REFERENCE`;
- a outbox esvaziou (nenhum evento confirmado ficou para trás).

O relatório traz throughput, latência p50/p95/p99, taxa de erro, status HTTP, desfechos, conflitos de concorrência (`concurrency_conflicts_total`, somado em todas as instâncias) e outbox lag (máximo amostrado de `outbox_lag_seconds` e tempo até esvaziar). Sai com código 1 se qualquer conferência falhar. Configuração: `LOAD_TARGETS`, `LOAD_WALLETS`, `LOAD_TRANSACTIONS`, `LOAD_CONCURRENCY`, `LOAD_DUPLICATE_RATIO`, `LOAD_INITIAL_BALANCE`, `LOAD_PENDING_TIMEOUT_MS` e `LOAD_SEED` (mesma semente → mesmo tráfego). Resultados e análise do gargalo no [ARCHITECTURE.md §16](ARCHITECTURE.md#16-testes).

## Comandos

| Comando | O que faz |
|---|---|
| `bun run dev` | API com watch |
| `bun start` | API sem watch |
| `bun test` | todos os testes |
| `bun run test:load` | teste de carga contra uma aplicação rodando |
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
| `DATABASE_POOL_MAX` | `10` | conexões por instância (teto de transações simultâneas) |
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
| `RECONCILIATION_WORKER_ENABLED` | `true` | liga a reconciliação agendada |
| `RECONCILIATION_INTERVAL_MS` | `3600000` (1 h) | intervalo entre varreduras, somando todas as instâncias |
| `RECONCILIATION_POLL_INTERVAL_MS` | `60000` | de quanto em quanto tempo cada instância pergunta se é a vez dela |
| `LOG_LEVEL` | `info` | `debug` · `info` · `warn` · `error` · `silent` |

## Estrutura

```
src/
  domain/            Money, Wallet, WalletLedgerEntry, WagerTransaction (puro: sem Nest, sem ORM)
  application/       casos de uso, portas, eventos, outbox/inbox, validação de entrada
  infrastructure/
    database/        entidades (EntitySchema), mappers, repositórios, unit of work, migrations
    messaging/       cliente SQS, publisher de eventos, consumer
    workers/         loops da outbox, do consumer, das referências pendentes e da reconciliação
    observability/   logger JSON, métricas Prometheus
  http/              controllers, presenters, filtro de erros, auth guard
  health/            liveness e readiness
test/
  unit/  integration/  e2e/  multi-instance/
scripts/             migrate.ts (migrations) · load-test.ts (teste de carga)
docker/localstack/   criação das filas
Dockerfile           imagem da aplicação (oven/bun, só dependências de produção)
```
