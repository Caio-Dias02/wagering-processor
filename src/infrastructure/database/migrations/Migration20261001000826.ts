import { Migration } from '@mikro-orm/migrations';

// round_id e game_id também são campos de negócio: entram na guarda de imutabilidade.
export class Migration20261001000826 extends Migration {

  override async up(): Promise<void> {
    this.addSql(guardFunction({ includeRoundAndGame: true }));
  }

  override async down(): Promise<void> {
    this.addSql(guardFunction({ includeRoundAndGame: false }));
  }

}

function guardFunction({ includeRoundAndGame }: { includeRoundAndGame: boolean }): string {
  const roundAndGame = includeRoundAndGame
    ? `
        or new.round_id                          is distinct from old.round_id
        or new.game_id                           is distinct from old.game_id`
    : '';

  return `
      create or replace function guard_wager_transaction_update() returns trigger
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
        or new.player_id                         is distinct from old.player_id${roundAndGame}
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
    `;
}
