/**
 * Teste de carga: `bun run test:load`.
 *
 * Bate numa aplicação JÁ RODANDO (local ou `docker compose --profile app up --scale app=3`)
 * e mede duas coisas:
 *  1. desempenho: requisições por segundo, latência p50/p95/p99, status devolvidos;
 *  2. correção sob carga: no fim, o saldo de cada wallet tem que bater com a soma
 *     do que as respostas disseram ter acontecido. Velocidade sem conferência não
 *     prova nada num sistema financeiro.
 *
 * O tráfego mistura o que o desafio pede: rodadas normais (BET → WIN/LOSS/REFUND/ROLLBACK),
 * referências fora de ordem (o desfecho chega antes da BET), duas reversões concorrentes
 * da mesma BET, reenvios duplicados em paralelo e wallets "quentes" concentrando tráfego.
 *
 * Configuração por variável de ambiente (todas opcionais):
 *   LOAD_TARGETS          URLs separadas por vírgula (padrão http://localhost:3000)
 *   LOAD_WALLETS          wallets criadas (padrão 20)
 *   LOAD_TRANSACTIONS     transações a enviar, sem contar duplicatas (padrão 2000)
 *   LOAD_CONCURRENCY      rodadas em paralelo (padrão 50)
 *   LOAD_DUPLICATE_RATIO  fração enviada duas vezes ao mesmo tempo (padrão 0.1)
 *   LOAD_INITIAL_BALANCE  saldo inicial de cada wallet (padrão 1000.00)
 *   LOAD_PENDING_TIMEOUT_MS  espera máxima pelas PENDING_REFERENCE (padrão 90000)
 *   LOAD_SEED             semente do gerador aleatório, para repetir uma execução
 */

// ---------- configuração ----------

const config = loadConfig();

function loadConfig() {
    const targets = (Bun.env.LOAD_TARGETS ?? "http://localhost:3000")
        .split(",")
        .map((t) => t.trim().replace(/\/+$/, ""))
        .filter((t) => t !== "");
    if (targets.length === 0) fail("LOAD_TARGETS must have at least one URL");

    const initialBalance = Bun.env.LOAD_INITIAL_BALANCE ?? "1000.00";
    if (!/^\d+\.\d{2}$/.test(initialBalance)) fail("LOAD_INITIAL_BALANCE must look like 1000.00");

    return {
        targets,
        wallets: intEnv("LOAD_WALLETS", 20, 1),
        transactions: intEnv("LOAD_TRANSACTIONS", 2000, 1),
        concurrency: intEnv("LOAD_CONCURRENCY", 50, 1),
        duplicateRatio: ratioEnv("LOAD_DUPLICATE_RATIO", 0.1),
        initialBalanceCents: toCents(initialBalance),
        pendingTimeoutMs: intEnv("LOAD_PENDING_TIMEOUT_MS", 90_000, 0),
        seed: intEnv("LOAD_SEED", Date.now() % 2 ** 31, 0),
    };
}

function intEnv(name: string, fallback: number, min: number): number {
    const raw = Bun.env[name];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min) fail(`${name} must be an integer >= ${min} (got "${raw}")`);
    return n;
}

function ratioEnv(name: string, fallback: number): number {
    const raw = Bun.env[name];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 1) fail(`${name} must be a number between 0 and 1 (got "${raw}")`);
    return n;
}

function fail(message: string): never {
    console.error(`load test: ${message}`);
    process.exit(2);
}

// ---------- dinheiro em centavos (mesma regra do domínio: nada de number) ----------

function toCents(amount: string): bigint {
    const match = /^(-?)(\d+)\.(\d{2})$/.exec(amount);
    if (!match) throw new Error(`unexpected amount "${amount}"`);
    const cents = BigInt(match[2]!) * 100n + BigInt(match[3]!);
    return match[1] === "-" ? -cents : cents;
}

function toAmount(cents: bigint): string {
    const sign = cents < 0n ? "-" : "";
    const abs = cents < 0n ? -cents : cents;
    return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}

// ---------- aleatoriedade reproduzível ----------

/** mulberry32: pequeno e determinístico. Mesma LOAD_SEED → mesmo tráfego. */
function createRandom(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const random = createRandom(config.seed);
const randomInt = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));

// ---------- HTTP ----------

interface HttpResult {
    status: number; // 0 = erro de rede
    body: any;
}

let nextTarget = 0;

/** Distribui as requisições entre as instâncias (round-robin). */
async function http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<HttpResult> {
    const url = config.targets[nextTarget++ % config.targets.length] + path;
    try {
        const res = await fetch(url, {
            method,
            headers: { "content-type": "application/json", ...headers },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: res.status, body: await res.json().catch(() => null) };
    } catch {
        return { status: 0, body: null };
    }
}

// ---------- métricas da fase de carga ----------

const latencies: number[] = [];
const statusCounts = new Map<string, number>();
let retries = 0;

const count = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);

// ---------- modelo do que foi enviado ----------

const PROVIDER_ID = "load-provider";
const GAME_ID = "load-game";
const RUN_ID = Date.now().toString(36); // execuções diferentes não colidem nas keys

type Kind = "BET" | "WIN" | "LOSS" | "REFUND" | "ROLLBACK";

interface Wallet {
    id: string;
    playerId: string;
}

interface Tx {
    externalId: string;
    wallet: Wallet;
    kind: Kind;
    cents: bigint;
    roundId: string;
    reference?: Tx;
    /** Desfecho final: PROCESSED, REJECTED (com failureCode) ou ainda pendente. */
    status?: string;
    failureCode?: string | null;
    transactionId?: string;
}

const sent: Tx[] = [];
const problems: string[] = [];
let txCounter = 0;
let roundCounter = 0;

function newTx(wallet: Wallet, kind: Kind, cents: bigint, roundId: string, reference?: Tx): Tx {
    const tx: Tx = { externalId: `${RUN_ID}-${++txCounter}`, wallet, kind, cents, roundId, reference };
    sent.push(tx);
    return tx;
}

function payload(tx: Tx) {
    return {
        providerId: PROVIDER_ID,
        externalTransactionId: tx.externalId,
        playerId: tx.wallet.playerId,
        walletId: tx.wallet.id,
        roundId: tx.roundId,
        gameId: GAME_ID,
        kind: tx.kind,
        money: { amount: toAmount(tx.cents), currency: "BRL" },
        referenceExternalTransactionId: tx.reference?.externalId,
    };
}

/**
 * Envia como um provedor bem-comportado: 503 ou erro de rede = reenviar com a
 * MESMA Idempotency-Key (é o contrato da API). Mede cada tentativa.
 */
async function submitOnce(tx: Tx): Promise<HttpResult> {
    const key = `${PROVIDER_ID}:${tx.externalId}`;
    for (let attempt = 1; ; attempt++) {
        const started = performance.now();
        const result = await http("POST", "/wagering/transactions", payload(tx), { "Idempotency-Key": key });
        latencies.push(performance.now() - started);
        count(statusCounts, result.status === 0 ? "network error" : String(result.status));

        const transient = result.status === 0 || result.status === 503;
        if (!transient || attempt === 5) return result;
        retries++;
        await Bun.sleep(50 * attempt);
    }
}

/** Às vezes manda o MESMO pedido duas vezes em paralelo (entrega at-least-once). */
async function submit(tx: Tx): Promise<void> {
    const duplicated = random() < config.duplicateRatio;
    const results = await Promise.all(duplicated ? [submitOnce(tx), submitOnce(tx)] : [submitOnce(tx)]);

    for (const r of results) recordResponse(tx, r);
    if (duplicated) checkDuplicatePair(tx, results[0]!, results[1]!);
}

function recordResponse(tx: Tx, r: HttpResult): void {
    if (![200, 202, 422].includes(r.status)) {
        problems.push(`${tx.kind} ${tx.externalId}: unexpected HTTP ${r.status} ${JSON.stringify(r.body)}`);
        return;
    }
    tx.transactionId ??= r.body.transactionId;
    // 202 não é desfecho: quem decide é o worker de pendentes (conferido no fim).
    if (r.status !== 202) {
        tx.status = r.body.status;
        tx.failureCode = r.body.failureCode;
    }
}

function checkDuplicatePair(tx: Tx, a: HttpResult, b: HttpResult): void {
    if (a.status === 0 || b.status === 0) return; // já virou problema em recordResponse
    const where = `${tx.kind} ${tx.externalId}`;
    if (a.body?.transactionId !== b.body?.transactionId) {
        problems.push(`${where}: duplicate created two transactions (${a.body?.transactionId} / ${b.body?.transactionId})`);
    }
    if (!a.body?.idempotentReplay && !b.body?.idempotentReplay) {
        problems.push(`${where}: neither duplicate response was flagged as replay`);
    }
    // Com 202 o estado pode avançar entre as duas respostas; sem 202, têm que ser idênticas.
    const settled = a.status !== 202 && b.status !== 202;
    if (settled && (a.status !== b.status || JSON.stringify(a.body.balance) !== JSON.stringify(b.body.balance))) {
        problems.push(`${where}: replay differs from original (${JSON.stringify(a.body)} / ${JSON.stringify(b.body)})`);
    }
}

// ---------- geração do tráfego ----------

/** 10% das wallets recebem metade das rodadas: é onde o lock por wallet é exigido de verdade. */
function pickWallet(wallets: Wallet[]): Wallet {
    const hot = Math.max(1, Math.floor(wallets.length * 0.1));
    return wallets[random() < 0.5 ? randomInt(0, hot - 1) : randomInt(0, wallets.length - 1)]!;
}

function settlementFor(wallet: Wallet, bet: Tx): Tx {
    const r = random();
    if (r < 0.4) return newTx(wallet, "WIN", BigInt(randomInt(1, 10_000)), bet.roundId, bet);
    if (r < 0.8) return newTx(wallet, "LOSS", 0n, bet.roundId, bet);
    if (r < 0.9) return newTx(wallet, "REFUND", bet.cents, bet.roundId, bet);
    return newTx(wallet, "ROLLBACK", bet.cents, bet.roundId, bet);
}

async function playRound(wallet: Wallet): Promise<void> {
    const roundId = `${RUN_ID}-round-${++roundCounter}`;
    const bet = newTx(wallet, "BET", BigInt(randomInt(100, 5_000)), roundId);
    const r = random();

    if (r < 0.15) {
        // Fora de ordem: o desfecho chega antes da aposta (vira PENDING_REFERENCE).
        const settlement = settlementFor(wallet, bet);
        await submit(settlement);
        await submit(bet);
    } else if (r < 0.2) {
        // Duas reversões da mesma BET ao mesmo tempo: no máximo uma pode valer.
        await submit(bet);
        await Promise.all([
            submit(newTx(wallet, "REFUND", bet.cents, roundId, bet)),
            submit(newTx(wallet, "ROLLBACK", bet.cents, roundId, bet)),
        ]);
    } else {
        await submit(bet);
        await submit(settlementFor(wallet, bet));
    }
}

// ---------- etapas ----------

async function checkTargets(): Promise<void> {
    for (const target of config.targets) {
        const ready = await fetch(`${target}/health/ready`).then((r) => r.ok).catch(() => false);
        if (!ready) fail(`${target} is not ready (is the application running?)`);
    }
}

async function createWallets(): Promise<Wallet[]> {
    return Promise.all(
        Array.from({ length: config.wallets }, async () => {
            const playerId = Bun.randomUUIDv7();
            const r = await http("POST", "/wallets", {
                playerId,
                initialBalance: { amount: toAmount(config.initialBalanceCents), currency: "BRL" },
            });
            if (r.status !== 201) fail(`could not create wallet: HTTP ${r.status} ${JSON.stringify(r.body)}`);
            return { id: r.body.id as string, playerId };
        }),
    );
}

async function runLoad(wallets: Wallet[]): Promise<number> {
    const started = performance.now();
    const worker = async () => {
        while (txCounter < config.transactions) await playRound(pickWallet(wallets));
    };
    await Promise.all(Array.from({ length: config.concurrency }, worker));
    return (performance.now() - started) / 1000;
}

/** As PENDING_REFERENCE são resolvidas em segundo plano: espera todas terminarem. */
async function waitForPending(): Promise<void> {
    const deadline = Date.now() + config.pendingTimeoutMs;
    let pending = sent.filter((tx) => tx.status === undefined && tx.transactionId !== undefined);

    while (pending.length > 0 && Date.now() < deadline) {
        await Promise.all(
            pending.map(async (tx) => {
                const r = await http("GET", `/providers/${PROVIDER_ID}/wagering/transactions/${tx.externalId}`);
                if (r.status === 200 && !["PENDING", "PENDING_REFERENCE"].includes(r.body.status)) {
                    tx.status = r.body.status;
                    tx.failureCode = r.body.failureCode;
                }
            }),
        );
        pending = pending.filter((tx) => tx.status === undefined);
        if (pending.length > 0) await Bun.sleep(1_000);
    }
    for (const tx of pending) problems.push(`${tx.kind} ${tx.externalId}: still pending after ${config.pendingTimeoutMs}ms`);
}

/** Rejeições que este tráfego provoca de propósito. Qualquer outra é bug. */
const EXPECTED_FAILURES = new Set(["INSUFFICIENT_FUNDS", "REFERENCE_NOT_PROCESSED", "REFERENCE_ALREADY_REVERSED"]);

/** Quanto cada transação PROCESSED moveu no saldo, do ponto de vista do cliente. */
function effectOf(tx: Tx): bigint {
    switch (tx.kind) {
        case "BET":
            return -tx.cents;
        case "WIN":
        case "REFUND":
        case "ROLLBACK": // aqui o ROLLBACK sempre desfaz uma BET
            return tx.cents;
        case "LOSS":
            return 0n;
    }
}

async function verify(wallets: Wallet[]): Promise<void> {
    const expected = new Map(wallets.map((w) => [w.id, config.initialBalanceCents]));
    const reversalsByBet = new Map<Tx, number>();

    for (const tx of sent) {
        if (tx.status === "REJECTED" && !EXPECTED_FAILURES.has(tx.failureCode ?? "")) {
            problems.push(`${tx.kind} ${tx.externalId}: unexpected rejection ${tx.failureCode}`);
        }
        if (tx.status !== "PROCESSED") continue;
        expected.set(tx.wallet.id, expected.get(tx.wallet.id)! + effectOf(tx));
        if ((tx.kind === "REFUND" || tx.kind === "ROLLBACK") && tx.reference) {
            reversalsByBet.set(tx.reference, (reversalsByBet.get(tx.reference) ?? 0) + 1);
        }
    }

    for (const [bet, n] of reversalsByBet) {
        if (n > 1) problems.push(`BET ${bet.externalId}: reversed ${n} times`);
    }

    await Promise.all(
        wallets.map(async (w) => {
            const wallet = await http("GET", `/wallets/${w.id}`);
            const balance = toCents(wallet.body.balance.amount);
            const want = expected.get(w.id)!;
            if (balance !== want) {
                problems.push(`wallet ${w.id}: balance ${toAmount(balance)}, expected ${toAmount(want)} from responses`);
            }
            if (balance < 0n) problems.push(`wallet ${w.id}: negative balance ${toAmount(balance)}`);

            const recon = await http("POST", `/wallets/${w.id}/reconciliation`);
            if (recon.status !== 200 || recon.body.consistent !== true) {
                problems.push(`wallet ${w.id}: reconciliation failed ${JSON.stringify(recon.body)}`);
            }
        }),
    );
}

// ---------- relatório ----------

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

function report(seconds: number): void {
    const sorted = [...latencies].sort((a, b) => a - b);
    const ms = (v: number) => `${v.toFixed(1)} ms`;
    const outcomes = new Map<string, number>();
    for (const tx of sent) count(outcomes, tx.status === "REJECTED" ? `REJECTED ${tx.failureCode}` : (tx.status ?? "unknown"));

    console.log(`
== Teste de carga ==
alvos          ${config.targets.join(", ")}
wallets        ${config.wallets} · concorrência ${config.concurrency} · duplicatas ${config.duplicateRatio} · seed ${config.seed}
transações     ${sent.length} (+ duplicatas e reenvios = ${latencies.length} requisições, ${retries} reenvios após 503/rede)
duração        ${seconds.toFixed(2)} s
throughput     ${(latencies.length / seconds).toFixed(1)} req/s
latência       p50 ${ms(percentile(sorted, 50))} · p95 ${ms(percentile(sorted, 95))} · p99 ${ms(percentile(sorted, 99))} · máx ${ms(sorted.at(-1) ?? 0)}
status HTTP    ${[...statusCounts].map(([k, v]) => `${k}: ${v}`).join(" · ")}
desfechos      ${[...outcomes].sort().map(([k, v]) => `${k}: ${v}`).join(" · ")}
`);

    if (problems.length === 0) {
        console.log("✅ consistente: saldos batem com as respostas, reconciliação ok, nenhuma reversão dupla, replays idênticos");
        return;
    }
    console.log(`❌ ${problems.length} problema(s):`);
    for (const p of problems.slice(0, 20)) console.log(`  - ${p}`);
    if (problems.length > 20) console.log(`  ... e mais ${problems.length - 20}`);
}

// ---------- main ----------

export { }; // top-level await exige que o arquivo seja um módulo

await checkTargets();
const wallets = await createWallets();
const seconds = await runLoad(wallets);
await waitForPending();
await verify(wallets);
report(seconds);
process.exit(problems.length === 0 ? 0 : 1);
