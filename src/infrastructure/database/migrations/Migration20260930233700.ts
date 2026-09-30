import { Migration } from '@mikro-orm/migrations';

export class Migration20260930233700 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table "inbox_messages" ("consumer_name" text not null, "message_id" text not null, "payload_hash" text not null, "received_at" timestamptz not null, "processed_at" timestamptz null, constraint "inbox_messages_pkey" primary key ("consumer_name", "message_id"));`);

    this.addSql(`create table "outbox_messages" ("id" uuid not null, "seq" bigserial, "aggregate_id" uuid not null, "event_type" text not null, "payload" jsonb not null, "occurred_at" timestamptz not null, "attempts" int not null default 0, "next_attempt_at" timestamptz not null, "published_at" timestamptz null, constraint "outbox_messages_pkey" primary key ("id"), constraint outbox_attempts_non_negative_ck check (attempts >= 0));`);
    this.addSql(`alter table "outbox_messages" add constraint "outbox_seq_uq" unique ("seq");`);
    this.addSql(`create index "outbox_pending_idx" on "outbox_messages" ("next_attempt_at", "seq") where published_at is null;`);

    this.addSql(`create table "wallets" ("id" uuid not null, "player_id" uuid not null, "currency" char(3) not null, "balance" numeric(19,2) not null, "version" int not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "wallets_pkey" primary key ("id"), constraint wallets_balance_non_negative_ck check (balance >= 0), constraint wallets_version_positive_ck check (version >= 1), constraint wallets_currency_format_ck check (currency ~ '^[A-Z]{3}\$'));`);
    this.addSql(`alter table "wallets" add constraint "wallets_player_currency_uq" unique ("player_id", "currency");`);
    this.addSql(`alter table "wallets" add constraint "wallets_id_currency_uq" unique ("id", "currency");`);

    this.addSql(`create table "wager_transactions" ("id" uuid not null, "provider_id" text not null, "external_transaction_id" text not null, "idempotency_key" text not null, "payload_hash" text not null, "wallet_id" uuid not null, "player_id" uuid not null, "round_id" text not null, "game_id" text not null, "kind" text not null, "amount" numeric(19,2) not null, "currency" char(3) not null, "reference_external_transaction_id" text null, "reference_transaction_id" uuid null, "status" text not null, "failure_code" text null, "observed_balance" numeric(19,2) null, "reference_attempts" int not null default 0, "next_reference_attempt_at" timestamptz null, "created_at" timestamptz not null, "processed_at" timestamptz null, constraint "wager_transactions_pkey" primary key ("id"), constraint wager_tx_kind_ck check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')), constraint wager_tx_status_ck check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')), constraint wager_tx_amount_non_negative_ck check (amount >= 0), constraint wager_tx_reference_required_ck check (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null), constraint wager_tx_opening_internal_ck check ((kind = 'OPENING') = (provider_id = 'internal')), constraint wager_tx_failure_has_code_ck check (status not in ('REJECTED', 'FAILED') or failure_code is not null), constraint wager_tx_terminal_has_date_ck check (status not in ('PROCESSED', 'REJECTED', 'FAILED') or processed_at is not null));`);
    this.addSql(`create index "wager_tx_pending_reference_idx" on "wager_transactions" ("next_reference_attempt_at") where status = 'PENDING_REFERENCE';`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_tx_idempotency_key_uq" unique ("idempotency_key");`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_tx_provider_external_uq" unique ("provider_id", "external_transaction_id");`);
    this.addSql(`create unique index "wager_tx_single_reversal_uq" on "wager_transactions" ("reference_transaction_id", "kind") where kind in ('REFUND', 'ROLLBACK') and status = 'PROCESSED';`);

    this.addSql(`create table "wallet_ledger_entries" ("id" uuid not null, "seq" bigserial, "wallet_id" uuid not null, "transaction_id" uuid not null, "direction" text not null, "amount" numeric(19,2) not null, "currency" char(3) not null, "balance_before" numeric(19,2) not null, "balance_after" numeric(19,2) not null, "created_at" timestamptz not null, constraint "wallet_ledger_entries_pkey" primary key ("id"), constraint ledger_direction_ck check (direction in ('DEBIT', 'CREDIT')), constraint ledger_amount_positive_ck check (amount > 0), constraint ledger_balance_before_non_negative_ck check (balance_before >= 0), constraint ledger_balance_after_non_negative_ck check (balance_after >= 0), constraint ledger_arithmetic_ck check ((direction = 'CREDIT' and balance_after = balance_before + amount) or (direction = 'DEBIT' and balance_after = balance_before - amount)));`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "ledger_seq_uq" unique ("seq");`);
    this.addSql(`create index "ledger_wallet_seq_idx" on "wallet_ledger_entries" ("wallet_id", "seq");`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "ledger_one_entry_per_tx_wallet_uq" unique ("transaction_id", "wallet_id");`);

    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_wallet_id_foreign" foreign key ("wallet_id") references "wallets" ("id") on update cascade;`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_reference_transaction_id_foreign" foreign key ("reference_transaction_id") references "wager_transactions" ("id") on update cascade on delete set null;`);

    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_transaction_id_foreign" foreign key ("transaction_id") references "wager_transactions" ("id") on update cascade;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "wager_transactions" drop constraint "wager_transactions_wallet_id_foreign";`);

    this.addSql(`alter table "wager_transactions" drop constraint "wager_transactions_reference_transaction_id_foreign";`);

    this.addSql(`alter table "wallet_ledger_entries" drop constraint "wallet_ledger_entries_transaction_id_foreign";`);

    this.addSql(`drop table if exists "inbox_messages" cascade;`);

    this.addSql(`drop table if exists "outbox_messages" cascade;`);

    this.addSql(`drop table if exists "wallets" cascade;`);

    this.addSql(`drop table if exists "wager_transactions" cascade;`);

    this.addSql(`drop table if exists "wallet_ledger_entries" cascade;`);
  }

}
