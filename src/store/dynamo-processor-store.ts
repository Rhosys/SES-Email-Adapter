import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { dynamo, TABLE } from "./dynamo-client.js";
import type { ProcessorStore } from "../processor/processor.js";
import type { Signal, Arc, Rule, EmailAddressConfig, AccountFilteringConfig } from "../types/index.js";

export class DynamoProcessorStore implements ProcessorStore {
  async getSignalByMessageId(messageId: string): Promise<Pick<Signal, "id" | "messageId"> | null> {
    const result = await dynamo.send(new GetCommand({
      TableName: TABLE,
      Key: { pk: `MSGID#${messageId}`, sk: "MSGID" },
      ProjectionExpression: "id, messageId",
    }));
    return result.Item ? (result.Item as Pick<Signal, "id" | "messageId">) : null;
  }

  async saveSignal(signal: Signal): Promise<void> {
    const gsi1pk = signal.arcId ? `ARCSIG#${signal.arcId}` : `BLOCKED#${signal.accountId}`;
    const gsi1sk = `RECV#${signal.receivedAt}#${signal.id}`;

    await Promise.all([
      dynamo.send(new PutCommand({
        TableName: TABLE,
        Item: { ...signal, pk: `SIG#${signal.id}`, sk: "SIGNAL", gsi1pk, gsi1sk },
      })),
      dynamo.send(new PutCommand({
        TableName: TABLE,
        Item: { pk: `MSGID#${signal.messageId}`, sk: "MSGID", id: signal.id, messageId: signal.messageId },
      })),
    ]);
  }

  async getArc(id: string): Promise<Arc | null> {
    const result = await dynamo.send(new GetCommand({
      TableName: TABLE,
      Key: { pk: `ARC#${id}`, sk: "ARC" },
    }));
    return result.Item ? (result.Item as Arc) : null;
  }

  async findArcByGroupingKey(accountId: string, key: string): Promise<Arc | null> {
    const result = await dynamo.send(new GetCommand({
      TableName: TABLE,
      Key: { pk: `GKEY#${accountId}#${key}`, sk: "GKEY" },
      ProjectionExpression: "arcId",
    }));
    if (!result.Item) return null;
    const arcId = result.Item["arcId"] as string | undefined;
    if (!arcId) return null;
    return this.getArc(arcId);
  }

  async saveArc(arc: Arc): Promise<void> {
    const writes: Promise<unknown>[] = [
      dynamo.send(new PutCommand({
        TableName: TABLE,
        Item: {
          ...arc,
          pk: `ARC#${arc.id}`,
          sk: "ARC",
          gsi1pk: `ACCT#${arc.accountId}`,
          gsi1sk: `ARC#${arc.lastSignalAt}#${arc.id}`,
        },
      })),
    ];

    if (arc.groupingKey) {
      writes.push(dynamo.send(new PutCommand({
        TableName: TABLE,
        Item: { pk: `GKEY#${arc.accountId}#${arc.groupingKey}`, sk: "GKEY", arcId: arc.id },
      })));
    }

    await Promise.all(writes);
  }

  async listRules(accountId: string): Promise<Rule[]> {
    const result = await dynamo.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": `ACCT#${accountId}`, ":prefix": "RULE#" },
    }));
    return ((result.Items ?? []) as Rule[]).sort((a, b) => a.position - b.position);
  }

  async getEmailAddressConfig(accountId: string, address: string): Promise<EmailAddressConfig | null> {
    const result = await dynamo.send(new GetCommand({
      TableName: TABLE,
      Key: { pk: `ACCT#${accountId}`, sk: `EMAILCFG#${address}` },
    }));
    return result.Item ? (result.Item as EmailAddressConfig) : null;
  }

  async saveEmailAddressConfig(config: EmailAddressConfig): Promise<void> {
    await dynamo.send(new PutCommand({
      TableName: TABLE,
      Item: { ...config, pk: `ACCT#${config.accountId}`, sk: `EMAILCFG#${config.address}` },
    }));
  }

  async getAccountFilteringConfig(accountId: string): Promise<AccountFilteringConfig | null> {
    const result = await dynamo.send(new GetCommand({
      TableName: TABLE,
      Key: { pk: `ACCT#${accountId}`, sk: "FILTERCFG" },
    }));
    if (!result.Item) return null;
    const { defaultFilterMode, newAddressHandling } = result.Item as AccountFilteringConfig;
    return { defaultFilterMode, newAddressHandling };
  }

  async updateGlobalReputation(domain: string, update: { wasSpam: boolean; wasBlocked: boolean }): Promise<void> {
    const now = new Date().toISOString();
    const addParts = ["signalCount :one"];
    if (update.wasSpam) addParts.push("spamCount :one");
    if (update.wasBlocked) addParts.push("blockCount :one");

    await dynamo.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: `GREP#${domain}`, sk: "GLOBAL_REP" },
      UpdateExpression: `ADD ${addParts.join(", ")} SET lastSeenAt = :now, updatedAt = :now, #domain = :domain`,
      ExpressionAttributeNames: { "#domain": "domain" },
      ExpressionAttributeValues: { ":one": 1, ":now": now, ":domain": domain },
    }));
  }
}
