export function computeUndoWindowSeconds(textBody: string | undefined): number {
  const wordCount = textBody?.trim().split(/\s+/).filter(Boolean).length ?? 0;
  if (wordCount < 50) return 10;
  if (wordCount < 200) return 60;
  if (wordCount < 500) return 180;
  return 300;
}
