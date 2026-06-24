// Email template color palettes — injected at render time via Mustache.
// Templates reference these as {{theme.base}}, {{theme.accent}}, etc.
//
// Currently we always inject the LIGHT palette. In future we may want to select
// the palette based on the user's preference (stored in account settings).
//
// ⚠️  DARK PALETTE CAVEATS — do NOT enable without addressing these:
//   • Gmail (web + mobile) applies an auto-inversion algorithm in dark mode.
//     It assumes emails are light-on-white and inverts them. A dark email gets
//     double-inverted → muddy light-gray background with dark text. Gmail does
//     not expose a CSS media query or opt-out mechanism.
//   • Samsung Mail behaves identically to Gmail dark mode.
//   • Outlook (Windows desktop, 2013–2021) uses the Word rendering engine and
//     ignores background-color on body/wrapper elements entirely — forces white.
//   • Yahoo Mail strips body background-color in some clients.
//   • Apple Mail is the only major client that correctly respects
//     @media (prefers-color-scheme: dark) — but MJML/email HTML can't reliably
//     use media queries across all clients.
//   • Net effect: a dark-themed email looks correct in ~20% of clients and
//     broken in the rest. Until Gmail provides a signal (meta tag, media query,
//     or color-scheme declaration), light palette is the only safe default.

export interface IEmailTheme {
  base: string
  mantle: string
  crust: string
  surface0: string
  surface1: string
  text: string
  subtext: string
  overlay: string
  accent: string
  accentText: string
  accentHover: string
  success: string
  warning: string
  error: string
  link: string
  divider: string
  footerBg: string
  footerText: string
}

export const LIGHT_THEME: IEmailTheme = {
  // Catppuccin Latte palette — matches the product UI's light mode
  base: "#eff1f5",
  mantle: "#e6e9ef",
  crust: "#dce0e8",
  surface0: "#ccd0da",
  surface1: "#bcc0cc",
  text: "#4c4f69",
  subtext: "#6c6f85",
  overlay: "#9ca0b0",
  accent: "#8839ef",       // mauve (latte)
  accentText: "#ffffff",
  accentHover: "#7287fd",  // lavender (latte)
  success: "#40a02b",      // green (latte)
  warning: "#df8e1d",      // yellow (latte)
  error: "#d20f39",        // red (latte)
  link: "#1e66f5",         // blue (latte)
  divider: "#ccd0da",      // surface0 (latte)
  footerBg: "#dce0e8",     // crust (latte)
  footerText: "#6c6f85",   // subtext0 (latte)
}

// ⚠️  NOT USED — see caveats above. Kept here so the palette is ready when/if
// we implement user-preference-based theme selection.
export const DARK_THEME: IEmailTheme = {
  // Catppuccin Mocha palette — matches the product UI's default dark mode
  base: "#1e1e2e",
  mantle: "#181825",
  crust: "#11111b",
  surface0: "#313244",
  surface1: "#45475a",
  text: "#cdd6f4",
  subtext: "#a6adc8",
  overlay: "#6c7086",
  accent: "#cba6f7",       // mauve (mocha)
  accentText: "#11111b",
  accentHover: "#b4befe",  // lavender (mocha)
  success: "#a6e3a1",      // green (mocha)
  warning: "#f9e2af",      // yellow (mocha)
  error: "#f38ba8",        // red (mocha)
  link: "#89b4fa",         // blue (mocha)
  divider: "#313244",      // surface0 (mocha)
  footerBg: "#181825",     // mantle (mocha)
  footerText: "#a6adc8",   // subtext0 (mocha)
}

export function getEmailTheme(): IEmailTheme {
  // TODO: Accept accountId and resolve user's preferred theme from account settings.
  // When implementing: query the account's `emailThemePreference` field and return
  // the matching palette. Default to LIGHT_THEME when unset.
  return LIGHT_THEME
}
