#!/bin/bash
# Roda quando o LocalStack fica pronto (/etc/localstack/init/ready.d). Idempotente:
# create-queue com os mesmos atributos não falha se a fila já existir.
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
ACCOUNT="000000000000"

# Entrada: transações vindas dos provedores. Depois de 5 recebimentos sem ack, vai para a DLQ.
awslocal sqs create-queue --region "$REGION" --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true

awslocal sqs create-queue --region "$REGION" --queue-name wager-transactions.fifo \
  --attributes "{
    \"FifoQueue\": \"true\",
    \"VisibilityTimeout\": \"30\",
    \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"arn:aws:sqs:${REGION}:${ACCOUNT}:wager-transactions-dlq.fifo\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"
  }"

# Saída: eventos de integração publicados pelo worker da outbox.
awslocal sqs create-queue --region "$REGION" --queue-name wagering-events.fifo \
  --attributes FifoQueue=true

echo "SQS queues ready"
