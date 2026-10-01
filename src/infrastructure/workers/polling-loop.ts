import { Logger } from "@nestjs/common";

export interface PollingLoopOptions {
    /** Espera quando não há trabalho. */
    idleDelayMs: number;
    /** Espera depois de um erro inesperado (evita loop quente batendo num banco fora do ar). */
    errorDelayMs: number;
}

/**
 * Roda `tick` em loop. `tick` devolve true quando provavelmente há mais trabalho
 * (aí roda de novo na hora) e false quando não há (aí espera idleDelayMs).
 * `stop()` espera o tick atual terminar: nada fica pela metade no desligamento.
 */
export class PollingLoop {
    private readonly logger: Logger;
    private running = false;
    private loop: Promise<void> | undefined;
    private wake: (() => void) | undefined;

    constructor(
        name: string,
        private readonly tick: () => Promise<boolean>,
        private readonly options: PollingLoopOptions,
    ) {
        this.logger = new Logger(name);
    }

    start(): void {
        if (this.running) return;
        this.running = true;
        this.loop = this.run();
    }

    async stop(): Promise<void> {
        this.running = false;
        this.wake?.(); // interrompe a espera, se estiver dormindo
        await this.loop;
    }

    private async run(): Promise<void> {
        while (this.running) {
            let delay = 0;
            try {
                const moreWork = await this.tick();
                if (!moreWork) delay = this.options.idleDelayMs;
            } catch (error) {
                this.logger.error(`tick failed: ${error instanceof Error ? error.message : String(error)}`);
                delay = this.options.errorDelayMs;
            }
            if (delay > 0 && this.running) await this.sleep(delay);
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => {
            const timer = setTimeout(done, ms);
            const self = this;
            function done() {
                clearTimeout(timer);
                self.wake = undefined;
                resolve();
            }
            this.wake = done;
        });
    }
}
