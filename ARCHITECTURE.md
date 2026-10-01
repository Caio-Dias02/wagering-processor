# Arquitetura

Este documento explica **como** o serviço garante as invariantes do desafio e **por que** cada decisão foi tomada, incluindo os trade-offs e as limitações conhecidas.

> Invariantes globais: nunca duplicar crédito, nunca duplicar débito, nunca perder um evento confirmado, nunca permitir saldo negativo — com mensagens duplicadas, fora de ordem e processadas por várias instâncias ao mesmo tempo.

## Sumário

1. [Visão geral](#1-visão-geral)
2. [Camadas](#2-camadas)
3. [Dinheiro](#3-dinheiro)
4. [Modelo de domínio e transições](#4-modelo-de-domínio-e-transições)
5. [Concorrência](#5-concorrência)
6. [Idempotência](#6-idempotência)
7. [Regras de negócio e interpretações](#7-regras-de-negócio-e-interpretações)
8. [Códigos de falha](#8-códigos-de-falha)
9. [API HTTP e status](#9-api-http-e-status)
10. [Garantias no schema](#10-garantias-no-schema)
11. [Mensageria: consumer, inbox, outbox](#11-mensageria-consumer-inbox-outbox)
12. [Referências fora de ordem](#12-referências-fora-de-ordem)
13. [Observabilidade](#13-observabilidade)
14. [Autenticação](#14-autenticação)
15. [ORM e estratégia transacional](#15-orm-e-estratégia-transacional)
16. [Testes](#16-testes)
17. [Limitações e trade-offs](#17-limitações-e-trade-offs)

---

## 1. Visão geral

```
                 ┌──────────────── mesma transação SQL ────────────────┐
 HTTP ──┐        │  lock da wallet (FOR UPDATE)                        │
        ├──► ProcessWagerTransaction ──► idempotência ──► regras ──►   │
 SQS ───┘        │  inbox* + transação + saldo + ledger + outbox       │
 (consumer)      └─────────────────────────────────────────────────────┘
                                   │ commit
                                   ▼
                     outbox_messages (pendentes)
                                   │  FOR UPDATE SKIP LOCKED
                                   ▼
                     OutboxWorker ──► SQS wagering-events.fifo

  PendingReferenceWorker ── FOR UPDATE SKIP LOCKED ──► resolve PENDING_REFERENCE
  ReconciliationWorker ──── lease em scheduled_jobs ──► varre e reconcilia as wallets
  (* inbox só quando a entrada é a fila)
```

Todos os processos são iguais: cada instância serve a API **e** roda o consumer, o publisher da outbox, o worker de pendentes e o agendador da reconciliação. Não há líder nem coordenação em memória — toda a coordenação é feita pelo Postgres (locks de linha, constraints, `SKIP LOCKED` e a lease dos jobs agendados). Por isso a solução é correta com N instâncias, o que é verificado em teste com 3 processos reais (ver [§16](#16-testes)).

## 2. Camadas

```
src/
  domain/          regras puras: Money, Wallet, WalletLedgerEntry, WagerTransaction
                   sem Nest, sem ORM, sem I/O
  application/     casos de uso, portas (interfaces), eventos, outbox/inbox,
                   validação de entrada (compartilhada entre HTTP e SQS)
  infrastructure/  MikroORM (records, mappers, repositórios, unit of work),
                   SQS (publisher, consumer), workers, observabilidade
  http/            controllers, presenters, filtro de erros, auth guard
```

- O domínio recebe ids e datas de fora; a aplicação gera ids com `Bun.randomUUIDv7()` (ordenáveis no tempo, bons para índice).
- Os casos de uso não têm decorators do Nest: são montados por factory nos módulos. Isso mantém a aplicação testável sem o container de DI.
- **O mesmo caso de uso** (`ProcessWagerTransaction`) atende a API e a fila; a validação de formato (`application/input-validation.ts`) também é a mesma, então os dois canais recusam exatamente as mesmas coisas.
- Construtores privados + factories `create`/`open`/`from` (validam) e `rehydrate` (reconstrói do banco sem revalidar transições), como pede o enunciado.

## 3. Dinheiro

| Onde | Representação |
|---|---|
| Domínio | `Money` imutável com **centavos em `bigint`** + moeda ISO-4217 |
| Contratos (API, fila, eventos) | `{ "amount": "25.00", "currency": "BRL" }` — string, escala fixa de 2 |
| Banco | `numeric(19,2)`, lido pelo driver como **string** e reidratado com `Money.rehydrate` |

- `Money.from` (entrada externa) aceita só `^(0|[1-9]\d{0,16})\.\d{2}$`: rejeita `NaN`, `Infinity`, notação científica, vazio, mais de 2 casas, negativos e zeros à esquerda. **Nunca arredonda: rejeita.**
- `Money.rehydrate` (valor persistido) aceita negativo, porque resultados intermediários (ex.: `negate()`) podem sê-lo.
- Operações entre moedas diferentes lançam `CurrencyMismatchError`.
- Em nenhum ponto o valor passa por `number`.
- **Limite de saldo**: o maior valor de `numeric(19,2)` (`99999999999999999.99`). Um crédito que passaria disso é rejeitado como regra da `Wallet` (`BALANCE_LIMIT_EXCEEDED`), em vez de estourar como erro de banco.

O desafio permite assumir só BRL; o modelo continua multi-moeda (uma wallet por `playerId + currency`) e o conflito de moeda é testado.

## 4. Modelo de domínio e transições

**Wallet** (aggregate root): `balance`, `version`. `debit`/`credit` são o **único** lugar que altera o saldo, e sempre devolvem o `WalletLedgerEntry` correspondente — não existe mudança de saldo sem lançamento. `version` começa em 1 e só incrementa quando o saldo muda.

**WalletLedgerEntry**: imutável por estrutura (sem setters, sem transições). `create` valida `balanceBefore ± amount = balanceAfter`, `amount > 0` e saldo final não negativo.

**WagerTransaction** — máquina de estados:

```
           ┌──────────────► PROCESSED   (terminal)
 PENDING ──┼──────────────► REJECTED    (terminal)
 (memória) └──► PENDING_REFERENCE ──┬──► PROCESSED
                                    └──► REJECTED  (inclusive REFERENCE_NOT_FOUND ao esgotar tentativas)
                                         FAILED    (terminal, reservado — ver §17)
```

- `PENDING` existe só em memória: a decisão acontece na mesma transação SQL em que a transação é gravada, então nunca se persiste `PENDING`.
- Transicionar um estado terminal lança `InvalidTransactionStateError`, que **não** é `DomainError`: é bug de programação, não regra de negócio. O banco reforça com trigger (ver [§10](#10-garantias-no-schema)).
- `OPENING` é interno (crédito de abertura da wallet), nasce `PROCESSED` e não pode ser submetido pela API nem pela fila; o `providerId` `internal` é reservado.

## 5. Concorrência

**Unidade de concorrência: a wallet.** Estratégia: **lock pessimista por linha** + **checagem de versão** como segunda linha de defesa.

1. `SELECT ... FROM wallets WHERE id = ? FOR UPDATE` no início da transação. Quem chega depois para a mesma wallet espera; wallets diferentes não se bloqueiam (não há lock global).
2. Com a wallet travada, o fluxo lê, decide e grava. A gravação do saldo é `UPDATE ... WHERE id = ? AND version = ?`; se nenhuma linha for afetada, lança `ConcurrencyConflictError`. Com o lock isso não deveria acontecer — é defesa em profundidade contra um caminho que esqueça de travar.
3. `CHECK (balance >= 0)` no banco: mesmo um bug de aplicação não consegue gravar saldo negativo.

**Por que pessimista e não otimista?** Wallet de apostas é *hot*: muitas operações pequenas na mesma linha em rajada. Com lock otimista, sob contenção, a maioria das tentativas falha e é repetida (trabalho desperdiçado e latência de cauda alta). Com `FOR UPDATE` as operações viram uma fila curta por wallet, a decisão é tomada sobre o saldo real, e o cenário 100/80/80 é resolvido naturalmente: a segunda aposta enxerga 20.00 e é rejeitada. O custo é o tempo de lock, minimizado mantendo a transação curta (sem I/O externo dentro dela).

**Ordem dos locks (evita deadlock).** Todo caminho trava no máximo uma wallet. O worker de pendentes trava a linha da transação pendente e depois a wallet; o fluxo normal trava a wallet e só **lê** outras transações (leitura não espera lock no Postgres). Não há ciclo de espera.

**Corridas perdidas.** Quando duas transações tentam gravar a mesma chave única ao mesmo tempo (ex.: mesma idempotency key para wallets diferentes, que não compartilham lock), a perdedora recebe violação de unique. O unit of work traduz isso para `ConcurrencyConflictError` e o caso de uso **repete do zero numa transação nova** (até 3 vezes) — depois de um erro o Postgres aborta a transação inteira, então não dá para "continuar" a anterior. Na nova tentativa, quem ganhou já está gravado e o resultado vira replay ou conflito.

**Workers concorrentes** (outbox e pendentes) usam `FOR UPDATE SKIP LOCKED`: cada instância pega um lote diferente sem esperar as outras.

## 6. Idempotência

Persistente no Postgres; nada de cache em memória.

| Garantia | Como |
|---|---|
| Mesma operação não aplica duas vezes | `UNIQUE(idempotency_key)` e `UNIQUE(provider_id, external_transaction_id)` |
| Replay devolve o resultado original | a transação guarda status, `failure_code` e o **saldo observado** no momento da decisão (`observed_balance`) |
| Mesma key com payload diferente | `payload_hash` diferente → **409**, nunca replay |
| Mesma mensagem da fila duas vezes | inbox `PRIMARY KEY (consumer_name, message_id)` na mesma transação |

**Fluxo**: travar a wallet → buscar pela key (e pelo par provider + id externo) → se existe e o hash bate, replay; se o hash difere, conflito → senão, decidir e gravar. As constraints únicas são o *backstop* para corridas que o lock não cobre (wallets diferentes); ver [§5](#5-concorrência).

Casos de borda tratados:
- mesmo `(providerId, externalTransactionId)` com **outra** key → 409;
- key reaproveitada apontando para uma wallet inexistente → 409 (e não `WALLET_NOT_FOUND`).

**payloadHash** = SHA-256 (hex) do **JSON canônico** — chaves ordenadas em todos os níveis, campos `undefined` removidos — deste subconjunto:

```
providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind,
money { amount, currency }, referenceExternalTransactionId
```

Ficam de fora: o header `Idempotency-Key`, `correlationId`, `messageId`, `occurredAt` e demais metadados de transporte (`application/payload-hash.ts`).

## 7. Regras de negócio e interpretações

| Operação | Saldo | Ledger | Referência |
|---|---|---|---|
| `BET` | débito | 1 `DEBIT` | proibida |
| `WIN` | crédito | 1 `CREDIT` | opcional; se informada, deve ser uma `BET` |
| `LOSS` | — | nenhum | opcional; se informada, deve ser uma `BET`; valor pode ser `0.00` |
| `REFUND` | crédito | 1 `CREDIT` | obrigatória; só `BET`; valor igual |
| `ROLLBACK` | inverso da referência | 1 entrada invertida | obrigatória; `BET`, `WIN` ou `REFUND`; valor igual |

A referência é resolvida por `(providerId, referenceExternalTransactionId)` e precisa ser do mesmo provider, player, wallet, moeda **e rodada**, e estar `PROCESSED`. Transação `REJECTED` não altera saldo nem gera ledger.

**Interpretações adotadas** (o enunciado pede que sejam documentadas):

1. **Uma referência só pode ser revertida uma vez, por qualquer tipo de reversão.** O enunciado diz "pelo mesmo tipo de operação". Seguido à risca, isso permitiria `ROLLBACK` e depois `REFUND` da mesma `BET`, devolvendo o valor duas vezes — crédito duplicado. Fomos mais rígidos. O índice único parcial do banco cobre "uma vez por tipo"; a regra "uma vez por qualquer tipo" é aplicada no caso de uso, sob o lock da wallet (as duas reversões de uma mesma referência sempre disputam o mesmo lock, porque a referência precisa ser da mesma wallet).
2. **`WIN`/`LOSS` não liquidam uma referência já revertida** (`REFERENCE_ALREADY_REVERSED`): não se paga prêmio de aposta cancelada.
3. **`REFUND` de uma `BET` que já teve `WIN` é aceito.** O enunciado não proíbe; cancelar uma aposta já premiada é responsabilidade do provedor (que faria `ROLLBACK` do `WIN`). Ver [§17](#17-limitações-e-trade-offs).
4. **Vários `WIN` para a mesma `BET` são aceitos** (rodadas com múltiplos prêmios existem).
5. **Reversão sem saldo** é rejeitada com `REVERSAL_INSUFFICIENT_FUNDS`, distinto de `INSUFFICIENT_FUNDS` da aposta, como pede o enunciado.
6. **Wallet de outro jogador** (`WALLET_OWNERSHIP_MISMATCH`) e **moeda diferente** (`CURRENCY_MISMATCH`) são rejeições persistidas **sem saldo observado**: no primeiro caso para não expor o saldo de terceiros; no segundo porque o saldo seria relido na moeda errada num replay.
7. **Wallet inexistente** não pode ser persistida (FK): responde `422 WALLET_NOT_FOUND` sem gravar transação.
8. **Uma transação que referencia a si mesma** é payload inválido (400): ficaria pendente para sempre.
9. Mensagens de erro nunca incluem saldo.

## 8. Códigos de falha

Estáveis e legíveis por máquina; o provedor decide pelo código se corrige, reenvia ou desiste.

| `failureCode` | Significado | Reenviar igual adianta? |
|---|---|---|
| `INSUFFICIENT_FUNDS` | aposta maior que o saldo | não |
| `REVERSAL_INSUFFICIENT_FUNDS` | reversão (débito) sem saldo | não (exige ação operacional) |
| `BALANCE_LIMIT_EXCEEDED` | crédito passaria do maior saldo representável | não |
| `CURRENCY_MISMATCH` | moeda da operação ≠ moeda da wallet | não; corrigir payload |
| `WALLET_OWNERSHIP_MISMATCH` | wallet não pertence ao `playerId` | não; corrigir payload |
| `WALLET_NOT_FOUND` | wallet não existe (não persistido) | não |
| `REFERENCE_NOT_FOUND` | referência não chegou dentro da janela de tentativas | não |
| `REFERENCE_MISMATCH` | referência de outro provider/player/wallet/moeda/rodada | não |
| `REFERENCE_KIND_NOT_ALLOWED` | tipo de referência inválido (ex.: `REFUND` de `WIN`) | não |
| `REFERENCE_NOT_PROCESSED` | referência existe mas foi rejeitada | não |
| `REFERENCE_ALREADY_REVERSED` | referência já revertida | não |
| `REFERENCE_AMOUNT_MISMATCH` | valor da reversão ≠ valor da referência | não |
| `INFRASTRUCTURE_FAILURE` | reservado para `FAILED` (não produzido hoje; ver §17) | — |

Erros de formato não viram transação: respondem 400 com `error.code` (`INVALID_REQUEST`, `INVALID_MONEY`, `INVALID_TRANSACTION`) e a lista de problemas.

## 9. API HTTP e status

O status sozinho diz ao provedor o que fazer — sem precisar interpretar mensagem:

| Status | Quando | O provedor deve |
|---|---|---|
| `200` | transação `PROCESSED` (original ou replay) | seguir |
| `201` | wallet criada | seguir |
| `202` | `PENDING_REFERENCE`: aceita, aplica quando a referência chegar | aguardar evento / consultar |
| `400` | payload inválido (formato, valor, kind, header ausente) | corrigir; reenviar igual não adianta |
| `404` | recurso inexistente (só em GETs e na reconciliação) | — |
| `409` | key já usada com outro payload; wallet duplicada | não reenviar com esse payload |
| `413` | corpo maior que 16 KB | corrigir |
| `422` | rejeição de negócio (corpo traz `failureCode`) ou `WALLET_NOT_FOUND` | decisão final; não reenviar |
| `503` | falha transitória (banco fora, deadlock, corrida esgotada); vem com `Retry-After` | reenviar **com a mesma key** (é seguro) |
| `500` | bug | — |

Detalhes:
- Replay devolve o **mesmo status** do original (um replay de rejeição continua 422).
- Erros têm sempre o corpo `{ "error": { "code", "message", "issues?" } }`; mensagens de 500 nunca vazam detalhes internos.
- Falhas transitórias são reconhecidas por uma lista explícita de SQLSTATEs e códigos de rede (`transient-errors.ts`). `08P01` (protocol violation), embora seja da classe de conexão, **não** é transitório: é causado pela entrada (ex.: byte NUL) e repetir nunca funcionaria — por isso caracteres de controle são recusados com 400 já na validação.
- Ledger paginado por **cursor opaco** (base64url sobre o `seq` bigserial): estável sob inserções concorrentes, não pula nem repete.

## 10. Garantias no schema

Restrição 9: unicidade, imutabilidade e não-negatividade são aplicadas **no banco**, não só no código.

| Tabela | Proteções |
|---|---|
| `wallets` | `CHECK balance >= 0`, `CHECK version >= 1`, `CHECK` formato da moeda, `UNIQUE(player_id, currency)`, `UNIQUE(id, currency)` (alvo da FK composta) |
| `wager_transactions` | `UNIQUE(idempotency_key)`, `UNIQUE(provider_id, external_transaction_id)`; `CHECK` de kind e status; referência obrigatória em `REFUND`/`ROLLBACK`; `OPENING` ⇔ provider `internal`; `REJECTED`/`FAILED` exigem `failure_code`; terminal exige `processed_at`; índice único parcial `(reference_transaction_id, kind) WHERE kind IN (REFUND, ROLLBACK) AND status = 'PROCESSED'`; **trigger** que impede alterar transação terminal ou qualquer campo de negócio (inclusive `round_id`/`game_id`); triggers que impedem `DELETE` e `TRUNCATE` |
| `wallet_ledger_entries` | **append-only por trigger** (sem `UPDATE`, `DELETE`, `TRUNCATE`); `CHECK` da aritmética `balance_before ± amount = balance_after`; `amount > 0`; saldos `>= 0`; `UNIQUE(transaction_id, wallet_id)` (no máximo um lançamento por wallet por transação); **FK composta `(wallet_id, currency)` → `wallets(id, currency)`** (o lançamento não pode estar em outra moeda); `seq` bigserial para cursor estável |
| `inbox_messages` | `PRIMARY KEY (consumer_name, message_id)` |
| `outbox_messages` | `UNIQUE(seq)`, `CHECK attempts >= 0`, índice parcial de pendentes `(next_attempt_at, seq) WHERE published_at IS NULL` |
| `scheduled_jobs` | `PRIMARY KEY (name)`: uma linha (lease) por job agendado |

**Migrations** versionadas e reversíveis: a cadeia `up` → `down` de todas → `up` foi conferida num banco limpo (não há teste automatizado disso, porque o `down` apaga as tabelas do banco compartilhado pelos testes). Estratégia híbrida: uma migration **gerada** pelo MikroORM a partir das entidades (tabelas, checks, uniques, índices parciais) e migrations **manuais** com o que o ORM não gera (triggers, funções e a FK composta). A migration gerada não é editada à mão.

## 11. Mensageria: consumer, inbox, outbox

### Consumer (`wager-transactions.fifo`)

- `MessageGroupId` = wallet: o FIFO preserva a ordem por wallet. As mensagens de um lote são processadas em sequência pelo mesmo motivo.
- **Ack (delete) somente depois do commit.** Se o processo morrer entre o commit e o ack, a mensagem volta e o inbox a reconhece como repetida: ack sem reprocessar.
- O inbox é gravado com `INSERT ... ON CONFLICT DO NOTHING` **na mesma transação** do efeito financeiro: "registrada" significa "processada". Se duas instâncias receberem a mesma mensagem, a segunda espera a primeira terminar e então vê o registro.

| Situação | Ação |
|---|---|
| processada, rejeitada por negócio, pendente de referência, repetida | **ack** |
| transitória (banco fora, corrida esgotada, erro desconhecido) | sem ack; `ChangeMessageVisibility` com backoff (2, 4, 8… s, até 5 min); após `maxReceiveCount = 5` o **SQS** move para a DLQ (redrive policy) |
| permanente (JSON inválido, payload inválido, conflito de idempotência, wallet inexistente) | envia para `wager-transactions-dlq.fifo` com atributos `errorCode`/`errorReason` e dá ack |

- **SIGTERM**: para de receber (aborta o long polling), termina a mensagem em andamento e devolve as não iniciadas com visibilidade 0. Os workers param em `beforeApplicationShutdown`, antes do pool do banco fechar.

### Transactional outbox

- Transação, saldo, ledger, inbox e eventos são gravados **atomicamente**: ou tudo é confirmado, ou nada. Nenhum evento é publicado antes do commit.
- O `OutboxWorker` pega lotes de até 10 com `FOR UPDATE SKIP LOCKED`, publica com `SendMessageBatch` e marca como publicado — tudo na transação que mantém as linhas travadas. Se o processo morrer no meio, a transação é desfeita, as linhas destravam e **outra instância publica**. Resultado: **at-least-once** — pode haver duplicata, nunca perda. O consumidor deduplica pelo `eventId`.
- Na fila de eventos (`wagering-events.fifo`): `MessageGroupId = aggregateId` e `MessageDeduplicationId = eventId` (o SQS descarta reenvios em 5 min — otimização, não garantia).
- Falha de publicação: `attempts + 1` e backoff exponencial (1 s dobrando, até 5 min). **Sem limite de tentativas**: um evento confirmado não pode ser descartado; a métrica `outbox_lag_seconds` mostra quando algo está preso.

### Eventos

Envelope: classe abstrata `IntegrationEvent<T>` com uma subclasse por evento; `eventType` e `version` ficam no tipo. `data` carrega `MoneyProps` (string), nunca `Money`.

| Evento | Quando |
|---|---|
| `WagerTransactionProcessed` | qualquer transação aplicada, inclusive `LOSS` |
| `WagerTransactionRejected` | rejeição (sem saldo no payload) |
| `WalletBalanceChanged` | somente quando o saldo muda (inclui o crédito de abertura) |
| `WagerTransactionPendingReference` | referência ausente |

## 12. Referências fora de ordem

Transações cuja referência ainda não chegou (ou chegou mas também está pendente) ficam `PENDING_REFERENCE` e respondem `202`. O `PendingReferenceWorker`:

1. pega **uma** pendente vencida com `FOR UPDATE SKIP LOCKED`;
2. trava a wallet e **reaplica as mesmas regras** do fluxo normal (código compartilhado em `application/wager-decision.ts`) — o estado pode ter mudado enquanto ela esperava (ex.: a `BET` chegou e já foi revertida → `REFERENCE_ALREADY_REVERSED`);
3. se a referência continua ausente, agenda a próxima tentativa.

**Política**: até **8 tentativas** com backoff exponencial de 5 s (5, 10, 20, 40, 80, 160, 320 s; teto de 30 min) ≈ 21 minutos no total. Provedores enviam a operação dependente segundos — no máximo poucos minutos — depois da original; a janela dá folga grande para atraso real e devolve uma resposta definitiva no mesmo dia, em vez de deixar a transação pendurada. Esgotado o limite: `REJECTED` com `REFERENCE_NOT_FOUND` e evento `WagerTransactionRejected`.

## 13. Observabilidade

**Logs estruturados**: uma linha JSON por evento no stdout (inclusive os logs do próprio Nest). Cada decisão gera uma linha com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`, `externalTransactionId`, `kind`, `status`, `failureCode`, `durationMs`. **Valores, saldos e corpos de requisição nunca são logados** (há teste que garante isso). `correlationId` vem do header `X-Correlation-Id` (ou é gerado), volta na resposta e segue para os eventos.

**Métricas** (Prometheus, `GET /metrics`):

| Métrica | O que mostra |
|---|---|
| `wager_transactions_total{source,kind,status,replay}` | transações por status; `replay="true"` = duplicatas por idempotência |
| `inbox_duplicate_messages_total` | redeliveries barrados pelo inbox |
| `wager_transaction_processing_seconds` | latência de processamento |
| `concurrency_conflicts_total{operation}` | corridas perdidas que causaram retry |
| `sqs_messages_total{outcome,code}` | ack / retry / dead_letter por código |
| `sqs_dead_letter_queue_messages` | profundidade da DLQ |
| `outbox_lag_seconds`, `outbox_pending_messages` | idade do evento pendente mais antigo e fila da outbox |
| `outbox_publish_total{result}` | publicações e falhas |
| `pending_reference_transactions`, `pending_reference_resolutions_total{outcome}` | referências pendentes |
| `wallet_reconciliations_total{result}` | reconciliações e divergências |
| `http_requests_total{method,route,status}`, `http_request_duration_seconds` | HTTP por rota (template, sem ids) |

Labels não carregam ids (cardinalidade baixa). Os gauges de fila, outbox e pendentes são lidos da fonte a cada coleta, então valem igual com 1 ou N instâncias.

**Health**: `/health/live` (processo vivo, sem olhar dependências — reiniciar não conserta banco fora do ar) e `/health/ready` (Postgres e SQS respondendo, 2 s de timeout cada; 503 caso contrário). Sem autenticação.

**Reconciliação** (`POST /wallets/:id/reconciliation`): compara o saldo guardado com a soma do ledger, lidos numa **única instrução SQL** (um único snapshot — uma aposta commitada no meio não gera divergência falsa). Divergência **nunca é corrigida**: é logada, contada em métrica e sinalizada com `consistent: false`.

**Reconciliação agendada** (`ReconciliationWorker` → `ReconcileAllWallets`): varre todas as wallets, paginando por id, e reconcilia cada uma na própria transação curta, sem segurar lock nem conexão enquanto as apostas seguem. Toda instância roda o agendador, mas **só uma varre por ciclo**. Antes de começar, a instância reivindica o ciclo numa única instrução atômica:

```sql
insert into scheduled_jobs (name, last_started_at) values ('wallet-reconciliation', now())
on conflict (name) do update set last_started_at = excluded.last_started_at
 where scheduled_jobs.last_started_at <= now() - interval
returning name
```

Se a linha voltou, esta instância ganhou o ciclo. Se não voltou, outra já começou há menos de um intervalo. Duas instâncias ao mesmo tempo: a segunda espera a primeira e, ao reavaliar o `WHERE` com a linha nova, não atualiza nada. O relógio é o **do banco**, então diferenças de relógio entre instâncias não importam. Cada instância pergunta a cada `RECONCILIATION_POLL_INTERVAL_MS` (1 min); a varredura acontece a cada `RECONCILIATION_INTERVAL_MS` (1 h). No SIGTERM a varredura para entre uma wallet e outra. Divergências saem no log (`reconciliation sweep found divergent wallets`) e em `wallet_reconciliations_total{result="divergent"}`, que é a métrica para alertar.

## 14. Autenticação

Não implementada (não vale pontos e não deve competir com correção financeira). O ponto de extensão está no código: `AuthGuard` aplicado aos controllers de negócio, delegando a uma `ProviderIdentityPort` cuja implementação atual (`NoAuthProviderIdentity`) não autentica ninguém. Health e métricas ficam fora do guard.

Desenho pretendido:
- **Keycloak** como IdP; cada provedor é um *client* OAuth2 com **client credentials**.
- A implementação real da porta valida o JWT (assinatura via JWKS, `iss`, `aud`, `exp`) e devolve o `client_id`.
- O guard exige `client_id == providerId` do corpo: um provedor não lança transações em nome de outro.
- Mensagens da fila são canal interno confiável, mas a identidade do provedor nela continua sujeita às validações de domínio (referência do mesmo provider etc.).

## 15. ORM e estratégia transacional

- **MikroORM 6** (preferencial no enunciado), com `EntitySchema` — sem decorators no domínio. Os *records* de persistência ficam separados das classes de domínio, e mappers convertem entre os dois. O domínio não depende de tipos do ORM.
- `Money` ↔ `numeric(19,2)` como string; reidratado com `Money.rehydrate`.
- **Unit of Work explícito**: cada caso de uso roda em `orm.em.fork().transactional(...)` — um `EntityManager` isolado por transação, sem identity map compartilhado entre requisições. A porta `UnitOfWork` expõe só repositórios de domínio.
- Escritas usam operações nativas (`insert`, `nativeUpdate` com `WHERE version = ?`) em vez do flush implícito, para que cada SQL emitido seja explícito e previsível.
- O MikroORM é criado por factory própria no Nest: o pacote `@mikro-orm/nestjs` não declara suporte ao Nest 12.

## 16. Testes

`bun test` roda tudo contra **Postgres e LocalStack reais** (nada de mock de banco ou fila). Cada teste confere a invariante final `saldo da wallet == saldo reconstruído pelo ledger`.

| Exigência (§13 do desafio) | Onde |
|---|---|
| Money, Wallet, regras, conflito de moeda, payload divergente | `test/unit/*`, `test/integration/process-wager-transaction.test.ts` |
| Migrations e constraints | `persistence.test.ts` (triggers, unique, append-only); todo teste de integração aplica as migrations antes de rodar |
| Atomicidade wallet/ledger/inbox/outbox | `outbox.test.ts`, `sqs-consumer.test.ts` |
| Inbox e redelivery | `sqs-consumer.test.ts` |
| Publishers concorrentes na mesma outbox | `outbox.test.ts` |
| Retry e DLQ | `sqs-consumer.test.ts` (transitório → redrive após 5; permanente → DLQ direto) |
| 50 apostas iguais em paralelo → 1 débito | `process-wager-transaction.test.ts` (+ 20 via HTTP, + 30 entre 3 instâncias) |
| 100 / 80 / 80 | `process-wager-transaction.test.ts`, `multi-instance.test.ts` |
| Wallets distintas em paralelo | `process-wager-transaction.test.ts` |
| ≥ 3 instâncias simultâneas | `test/multi-instance/multi-instance.test.ts` (3 processos reais) |
| Worker morto depois do commit e antes do ack | `sqs-consumer.test.ts` |
| `ROLLBACK`/`REFUND` antes da referência | `pending-reference.test.ts` |
| Reinício com consistência final | `multi-instance.test.ts`: instância morta à força sob carga, outra sobe, todas as wallets reconciliam e a outbox esvazia |
| Crash depois do commit e antes de publicar | `outbox.test.ts` |
| Shutdown gracioso do consumer | `sqs-consumer.test.ts` |
| Reconciliação agendada, uma instância por ciclo | `reconcile-all-wallets.test.ts` (5 "instâncias" disputando o mesmo ciclo → só 1 varre) |
| Carga com conferência de saldo | `scripts/load-test.ts` (`bun run test:load`, abaixo) |

Os testes compartilham o mesmo banco; cada um cria suas próprias wallets com ids únicos.

### Teste de carga

`bun run test:load` gera tráfego contra uma aplicação rodando (uma ou várias instâncias, em round-robin) e **confere o dinheiro no fim**. O saldo de cada wallet tem que ser o saldo inicial mais o efeito de cada resposta `PROCESSED`, somado em centavos `bigint` do lado do cliente. Também confere a reconciliação, que nenhuma `BET` foi revertida duas vezes e que duplicatas devolveram a mesma transação. Mistura do tráfego: rodadas normais, desfecho antes da aposta (~15% das rodadas, viram `PENDING_REFERENCE`), `REFUND` e `ROLLBACK` concorrentes da mesma `BET` (~5%), 10% de reenvios duplicados em paralelo e metade das rodadas concentrada em 10% das wallets. O cliente se comporta como um provedor correto: reenvia com a mesma key em `503` ou erro de rede.

Resultados medidos em Windows 11 + Docker Desktop (VM com 8 vCPU), Bun 1.4.2, Postgres 17 no compose. **Todas as execuções terminaram consistentes**: nenhum centavo de diferença, nenhuma reversão dupla, todo replay idêntico ao original.

| Cenário | Throughput | p50 | p99 |
|---|---|---|---|
| 1 instância, 1 requisição por vez | 58 req/s | 16 ms | 39 ms |
| 1 instância, concorrência 5 | 124 req/s | 38 ms | 154 ms |
| 1 instância, concorrência 50 (padrão) | 95–150 req/s | 350–550 ms | 0,5–1 s |
| 3 instâncias em container, concorrência 150, 6000 transações | 185 req/s | 853 ms | 1,5 s |

**Onde está o gargalo** (investigado, não suposto):
- **Não é o lock por wallet.** Com 500 wallets em vez de 20 o throughput é o mesmo. Nas amostras do `pg_stat_activity` durante a carga, de 0 a 3 das ~10 conexões ativas esperavam por `Lock:transactionid`.
- **Não é o pool de conexões.** `DATABASE_POOL_MAX` 10 e 30 dão o mesmo resultado (148 contra 150 req/s).
- **Não é o Postgres.** A maioria das conexões ativas está em `Client:ClientRead`, ou seja, com a transação aberta esperando a aplicação mandar a próxima instrução.
- **É CPU da aplicação**, cerca de 10 ms por transação. Cada container fica em ~100–130% de CPU, o limite de uma thread de JavaScript. O perfil de CPU (`bun --cpu-prof-md`) não tem um ponto quente isolado: o custo se divide entre a montagem de queries do MikroORM (a maior fatia), o driver `pg`, o HTTP do Nest e a escrita dos logs.
- Acima de ~50 requisições em voo por instância, a latência cresce só por fila (lei de Little: 50 em voo ÷ ~100 req/s ≈ 500 ms).
- Com 3 instâncias o ganho não foi linear (~1,9×). A diferença provavelmente vem do próprio gerador de carga (um processo no Windows) e do repasse de portas do Docker Desktop. Não isolei isso.

Alavancas, em ordem de custo/benefício:
1. **Mais instâncias.** A aplicação não guarda estado, e o lock é por wallet, então wallets diferentes escalam em paralelo.
2. **SQL escrito à mão no caminho quente**, que hoje faz ~10 idas ao banco por transação: travar a wallet e buscar a idempotency key numa instrução só, e gravar transação, ledger e outbox num único round-trip.
3. **Logs** do caminho feliz em `debug`.

O que **não** se negocia por throughput: `synchronous_commit`, o lock por wallet e a gravação atômica com a outbox.

## 17. Limitações e trade-offs

- **`FAILED` e `INFRASTRUCTURE_FAILURE` não são produzidos.** Persistir `FAILED` por uma falha de infraestrutura transformaria uma queda temporária num resultado definitivo — e um replay passaria a devolver `FAILED` para sempre. Falhas transitórias respondem 503 (HTTP) ou voltam para a fila (SQS); as permanentes de mensagem vão para a DLQ com o motivo, onde ficam auditáveis. O status continua no schema e na máquina de estados para um uso futuro (ex.: operador encerrando manualmente uma transação presa).
- **`REFUND` depois de `WIN` é aceito** ([§7](#7-regras-de-negócio-e-interpretações)). Uma regra "BET liquidada não pode ser reembolsada" seria mais segura, mas pode recusar fluxos legítimos de alguns provedores; ficou como decisão consciente.
- **Ordem dos eventos não é estrita entre tentativas.** Dentro de um lote a ordem segue o `seq`, mas se a publicação de um evento falhar e a de um posterior não, o posterior sai antes. Consumidores devem usar `walletVersion` (em `WalletBalanceChanged`) e o `eventId` para ordenar e deduplicar.
- **Eventos emitidos pelo worker de pendentes** usam o id da transação como `correlationId`: o `correlationId` original da requisição não é persistido.
- **Long polling abandonado**: quando uma instância desliga, um receive em andamento pode ser concluído pelo SQS e a mensagem fica invisível até o fim do visibility timeout (30 s por padrão). Não há perda, só atraso.
- **Varredura de reconciliação interrompida não é retomada.** Se a instância cair (ou desligar) no meio, aquele ciclo fica incompleto, e a próxima varredura, um intervalo depois, recomeça do zero. Como ela só lê, repetir é seguro. Com milhões de wallets, valeria guardar um cursor na lease e conferir em lote (uma instrução por página em vez de uma por wallet).
- **Métricas de contador são por instância**; a agregação entre instâncias é papel do Prometheus. Os gauges operacionais leem a fonte compartilhada.
- **Throughput modesto por instância** (~100–150 req/s nesta máquina), limitado por CPU da aplicação, não por lock nem pelo banco ([§16](#teste-de-carga)). A escolha foi clareza e correção primeiro; as otimizações estão listadas e medidas, não aplicadas às cegas.
- **Autenticação não implementada** ([§14](#14-autenticação)).
- **LocalStack** emula o SQS; o comportamento da AWS real pode variar em detalhes (ex.: limites de purge, latência do redrive).
- **Saldo máximo** limitado a `numeric(19,2)`; contratos limitam valores a 17 dígitos inteiros.
