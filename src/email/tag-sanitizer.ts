export function sanitizeTagValue(value: string): string {
  return value.replace(/[^a-z0-9_-]/gi, "").slice(0, 255)
}

export function sanitizeTagName(name: string): string {
  return name.replace(/[^a-z0-9_-]/gi, "").slice(0, 255)
}

export interface EmailTagSet {
  accountId: string
  fullDate: string
  invocationId: string
  triggerId: string
}

export function buildEmailTags(tags: EmailTagSet): Array<{ Name: string; Value: string }> {
  return [
    { Name: sanitizeTagName("X-Numaeel-AccountId"), Value: sanitizeTagValue(tags.accountId) },
    { Name: sanitizeTagName("X-Numaeel-FullDate"), Value: sanitizeTagValue(tags.fullDate) },
    { Name: sanitizeTagName("X-Numaeel-InvocationId"), Value: sanitizeTagValue(tags.invocationId) },
    { Name: sanitizeTagName("X-Numaeel-TriggerId"), Value: sanitizeTagValue(tags.triggerId) },
  ]
}
