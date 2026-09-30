import { Migration } from '@mikro-orm/migrations';

export class Migration20260930233911 extends Migration {

  override async up(): Promise<void> {
    // Função genérica: bloqueia UPDATE / DELETE / TRUNCATE
    this.addSql(`
      create function forbid_mutation() returns trigger
      language plpgsql as $$
      begin
        raise exception '% on % is not allowed (append-only)', TG_OP, TG_TABLE_NAME
          using errcode = 'restrict_violation';
      end
      $$;
    `);

    // Transação terminal nunca muda; campos de negócio nunca mudam
    this.addSql(`
      create function guard_wager_transaction_update() returns trigger
      language plpgsql as $$
      begin
        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'wager_transaction % is terminal (%)', old.id, old.status
            using errcode = 'check_violation';
        end if;

        if new.provider_id                       is distinct from old.provider_id
        or new.external_transaction_id           is distinct from old.external_transaction_id
        or new.idempotency_key                   is distinct from old.idempotency_key
        or new.payload_hash                      is distinct from old.payload_hash
        or new.wallet_id                         is distinct from old.wallet_id
        or new.player_id                         is distinct from old.player_id
        or new.kind                              is distinct from old.kind
        or new.amount                            is distinct from old.amount
        or new.currency                          is distinct from old.currency
        or new.reference_external_transaction_id is distinct from old.reference_external_transaction_id
        then
          raise exception 'business fields of wager_transaction % are immutable', old.id
            using errcode = 'check_violation';
        end if;

        return new;
      end
      $$;
    `);

    // wager_transactions: guarda de update, sem delete, sem truncate
    this.addSql(`
      create trigger wager_transactions_guard_update
        before update on "wager_transactions"
        for each row execute function guard_wager_transaction_update();
    `);
    this.addSql(`
      create trigger wager_transactions_no_delete
        before delete on "wager_transactions"
        for each row execute function forbid_mutation();
    `);
    this.addSql(`
      create trigger wager_transactions_no_truncate
        before truncate on "wager_transactions"
        for each statement execute function forbid_mutation();
    `);

    // ledger: append-only (sem update, delete ou truncate)
    this.addSql(`
      create trigger wallet_ledger_entries_append_only
        before update or delete on "wallet_ledger_entries"
        for each row execute function forbid_mutation();
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_no_truncate
        before truncate on "wallet_ledger_entries"
        for each statement execute function forbid_mutation();
    `);

    // ledger: wallet_id + currency precisam bater com a wallet
    this.addSql(`
      alter table "wallet_ledger_entries"
        add constraint "ledger_wallet_currency_fk"
        foreign key ("wallet_id", "currency") references "wallets" ("id", "currency");
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "wallet_ledger_entries" drop constraint if exists "ledger_wallet_currency_fk";`);
    this.addSql(`drop trigger if exists wallet_ledger_entries_no_truncate on "wallet_ledger_entries";`);
    this.addSql(`drop trigger if exists wallet_ledger_entries_append_only on "wallet_ledger_entries";`);
    this.addSql(`drop trigger if exists wager_transactions_no_truncate on "wager_transactions";`);
    this.addSql(`drop trigger if exists wager_transactions_no_delete on "wager_transactions";`);
    this.addSql(`drop trigger if exists wager_transactions_guard_update on "wager_transactions";`);
    this.addSql(`drop function if exists guard_wager_transaction_update();`);
    this.addSql(`drop function if exists forbid_mutation();`);
  }

}