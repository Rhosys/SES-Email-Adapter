import type { Email } from "@ses-adapter/shared";

export interface EmailStore {
  saveEmail(email: Email): Promise<void>;
  getEmailByMessageId(messageId: string): Promise<Pick<Email, "id" | "messageId"> | null>;
}
