// ---------------------------------------------------------------------------
// Unsubscribe Header Builder — RFC 8058 List-Unsubscribe + One-Click
// ---------------------------------------------------------------------------

export function buildUnsubscribeHeaders(accountId: string, apiDomain: string, jwt: string): Array<{ Name: string; Value: string }> {
  return [
    { Name: "List-Unsubscribe", Value: `<https://${apiDomain}/accounts/${accountId}/unsubscribe?code=${jwt}>` },
    { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
  ]
}
