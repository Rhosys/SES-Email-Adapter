import { vi } from "vitest";
import type { ProviderAdapter } from "../../src/external-exchanges/provider-adapter.js";
import { EMX_PLATFORMS, type EmxPlatform } from "../../src/types/index.js";

/** A single mock adapter with every ProviderAdapter method stubbed, including sendMessage. */
export function makeMockAdapter(overrides?: Partial<ProviderAdapter>): ProviderAdapter {
  return {
    activate: vi.fn(),
    renew: vi.fn(),
    deactivate: vi.fn(),
    fetchMessage: vi.fn(),
    sendMessage: vi.fn(),
    ...overrides,
  };
}

/**
 * Builds the full Record<EmxPlatform, ProviderAdapter> the router and workers require. Every
 * platform is populated with a default mock; pass overrides to swap in a specific adapter for
 * the platform under test. The record is keyed by every EmxPlatform, so adding a platform to
 * EMX_PLATFORMS forces this helper (and its callers) to account for it.
 */
export function makeMockAdapters(overrides?: Partial<Record<EmxPlatform, ProviderAdapter>>): Record<EmxPlatform, ProviderAdapter> {
  const record = Object.fromEntries(EMX_PLATFORMS.map((platform) => [platform, makeMockAdapter()])) as Record<EmxPlatform, ProviderAdapter>;
  return { ...record, ...overrides };
}
