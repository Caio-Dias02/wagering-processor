import { InboxMessageSchema } from "./inbox-message.record";
import { OutboxMessageSchema } from "./outbox-message.record";
import { ScheduledJobSchema } from "./scheduled-job.record";
import { WagerTransactionSchema } from "./wager-transaction.record";
import { WalletLedgerEntrySchema } from "./wallet-ledger-entry.record";
import { WalletSchema } from "./wallet.record";

export const entities = [
    WalletSchema,
    WagerTransactionSchema,
    WalletLedgerEntrySchema,
    InboxMessageSchema,
    OutboxMessageSchema,
    ScheduledJobSchema,
];