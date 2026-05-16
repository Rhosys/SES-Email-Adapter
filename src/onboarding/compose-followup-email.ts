export interface OnboardingProgress {
  domainAdded: boolean;
  senderSetupComplete: boolean;
  emailsReceived: boolean;
}

export function composeFollowupEmail(progress: OnboardingProgress): { subject: string; textBody: string } {
  if (progress.domainAdded && progress.senderSetupComplete && progress.emailsReceived) {
    return {
      subject: "You're all set!",
      textBody: "Congratulations — your account is fully configured. You're receiving emails, your sender identity is verified, and replies are ready to go. No further action needed.",
    };
  }

  const suggestions: string[] = [];
  if (!progress.domainAdded) suggestions.push("• Add a custom domain to start receiving emails");
  if (!progress.senderSetupComplete) suggestions.push("• Complete sender setup (DKIM, SPF, DMARC) to enable replies and forwarding");
  if (!progress.emailsReceived) suggestions.push("• Send a test email to your domain to verify everything works");

  return {
    subject: "Next steps for your account",
    textBody: `Here's what's left to get the most out of your account:\n\n${suggestions.join("\n")}\n\nNeed help? Reply to this email and we'll get you sorted.`,
  };
}
