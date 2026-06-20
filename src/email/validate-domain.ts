/**
 * Validates a domain string against strict structural rules.
 *
 * Rules enforced:
 * - Total length ≤ 253
 * - At least two labels (e.g. "example.com")
 * - Each label 1–63 chars
 * - Lowercase alphanumeric + hyphen only (no underscores)
 * - No label starts or ends with hyphen
 * - No consecutive dots, no leading/trailing dots
 * - TLD ≥ 2 alphabetic characters
 * - No protocol prefix (e.g. "https://")
 * - No path or port (e.g. "/path", ":8080")
 */
export function isValidDomain(value: string): boolean {
  // Reject protocol prefixes
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return false
  }

  // Reject paths and ports
  if (value.includes('/') || value.includes(':')) {
    return false
  }

  // Total length check
  if (value.length === 0 || value.length > 253) {
    return false
  }

  // No leading or trailing dots
  if (value.startsWith('.') || value.endsWith('.')) {
    return false
  }

  // No consecutive dots
  if (value.includes('..')) {
    return false
  }

  const labels = value.split('.')

  // At least two labels
  if (labels.length < 2) {
    return false
  }

  for (const label of labels) {
    // Each label 1–63 chars
    if (label.length === 0 || label.length > 63) {
      return false
    }

    // Lowercase alphanumeric + hyphen only (no underscores)
    if (!/^[a-z0-9-]+$/.test(label)) {
      return false
    }

    // No label starts or ends with hyphen
    if (label.startsWith('-') || label.endsWith('-')) {
      return false
    }
  }

  // TLD must be ≥ 2 alphabetic characters
  const tld = labels[labels.length - 1]!
  if (!/^[a-z]{2,}$/.test(tld)) {
    return false
  }

  return true
}
