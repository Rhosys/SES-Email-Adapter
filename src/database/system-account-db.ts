export const SYSTEM_ACCOUNT_ID = "SYSTEM";

export function isSystemAccount(accountId: string): boolean {
  return accountId === SYSTEM_ACCOUNT_ID;
}
