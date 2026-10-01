export interface ReceiveInboxProps {
    messageId: string;
    consumerName: string;
    payloadHash: string;
    receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
    processedAt: Date | undefined;
}

/**
 * "Já recebi essa mensagem?" A chave (consumerName, messageId) é a PK no banco, então a
 * mesma mensagem entregue duas vezes pela fila não é processada duas vezes.
 * É gravada na mesma transação que o efeito financeiro.
 */
export class InboxMessage {
    private constructor(
        readonly messageId: string,
        readonly consumerName: string,
        readonly payloadHash: string,
        readonly receivedAt: Date,
        private _processedAt: Date | undefined,
    ) { }

    static receive(props: ReceiveInboxProps): InboxMessage {
        return new InboxMessage(props.messageId, props.consumerName, props.payloadHash, props.receivedAt, undefined);
    }

    static rehydrate(s: InboxMessageState): InboxMessage {
        return new InboxMessage(s.messageId, s.consumerName, s.payloadHash, s.receivedAt, s.processedAt);
    }

    get processedAt(): Date | undefined {
        return this._processedAt;
    }

    isProcessed(): boolean {
        return this._processedAt !== undefined;
    }

    markProcessed(at: Date): void {
        if (this.isProcessed()) return;
        this._processedAt = at;
    }
}
