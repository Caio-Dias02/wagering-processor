import { Controller, Get, Inject, Res } from "@nestjs/common";
import { GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import type { Response } from "express";
import { sqsConfig } from "../infrastructure/messaging/sqs.config";

const CHECK_TIMEOUT_MS = 2_000;

type CheckStatus = "up" | "down";

@Controller("health")
export class HealthController {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(SQSClient) private readonly sqs: SQSClient,
  ) {}

  /** O processo está vivo (não olha dependências: reiniciar não conserta banco fora do ar). */
  @Get("live")
  live() {
    return { status: "ok" };
  }

  /** Pode receber tráfego? Só se Postgres e SQS responderem. */
  @Get("ready")
  async ready(@Res({ passthrough: true }) res: Response) {
    const [postgres, sqs] = await Promise.all([
      check(() => this.orm.em.getConnection().execute("select 1")),
      check(() => this.sqs.send(new GetQueueUrlCommand({ QueueName: sqsConfig.inputQueueName }))),
    ]);
    const ready = postgres === "up" && sqs === "up";
    res.status(ready ? 200 : 503);
    return { status: ready ? "ok" : "unavailable", checks: { postgres, sqs } };
  }
}

async function check(probe: () => Promise<unknown>): Promise<CheckStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), CHECK_TIMEOUT_MS);
  });
  try {
    await Promise.race([probe(), timeout]);
    return "up";
  } catch {
    return "down";
  } finally {
    clearTimeout(timer);
  }
}
