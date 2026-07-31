// Wire format for SES notifications arriving inside the SNS Message field.
// Covers both inbound receipt notifications (notificationType: "Received") and
// feedback notifications (Bounce, Complaint, Delivery, etc.) routed through the
// same SQS queue.

export type SesVerdict = "PASS" | "FAIL" | "GRAY" | "PROCESSING_FAILED";

export interface SesInboundNotification {
  notificationType?: string;
  mail?: {
    messageId: string;
    timestamp: string;
    destination: string[];
    source?: string;
    headers?: Array<{ name: string; value: string }>;
  };
  receipt?: {
    recipients: string[];
    dkimVerdict: { status: SesVerdict };
    dmarcVerdict: { status: SesVerdict };
    spamVerdict?: { status: SesVerdict };
    virusVerdict?: { status: SesVerdict };
    action: { type: string; bucketName: string; objectKey: string };
  };
}
