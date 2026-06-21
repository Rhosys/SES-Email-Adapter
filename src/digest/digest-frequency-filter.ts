import { DateTime } from "luxon"

export type DigestFrequency = "daily" | "weekly" | "monthly"

export function shouldDispatchDigest(frequency: DigestFrequency, date: DateTime): boolean {
  switch (frequency) {
    case "daily":
      return true
    case "weekly":
      return date.weekday === 7 // Sunday
    case "monthly":
      return date.day === 1
  }
}

export function buildDigestSubject(frequency: DigestFrequency, date: DateTime): string {
  switch (frequency) {
    case "daily":
      return `Daily Numaeel Digest for ${date.weekdayLong}`
    case "weekly":
      return `Weekly Numaeel Digest for Week ${date.weekNumber}`
    case "monthly":
      return `Monthly Numaeel Digest for ${date.monthLong}`
  }
}
