import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from "@nestjs/common";
import { SQSClient } from "@aws-sdk/client-sqs";
import { createSqsClient } from "./sqs.config";

@Injectable()
class SqsShutdown implements OnApplicationShutdown {
    constructor(@Inject(SQSClient) private readonly sqs: SQSClient) { }

    onApplicationShutdown(): void {
        this.sqs.destroy();
    }
}

@Global()
@Module({
    providers: [{ provide: SQSClient, useFactory: createSqsClient }, SqsShutdown],
    exports: [SQSClient],
})
export class MessagingModule { }
