/**
 * IANA timezone allowlist with the zone abbreviations that may appear in email
 * dates (e.g. "5:30 PM CEST", "14:00 UTC+2"). Each entry pairs a canonical IANA
 * `tzCode` with every abbreviation that names it across the year: alphabetic
 * names (CET/CEST, PST/PDT) plus the numeric `UTC±N` form for both DST states.
 *
 * Provenance (authored, not runtime): alphabetic abbreviations are the union of
 * the Wikipedia "List of tz database time zones" SDT/DST columns and luxon's
 * en-US short names sampled in January and July. The `UTC±N` aliases are
 * derived from each zone's actual offset in January and July (both seasons, so
 * a DST zone carries both, e.g. Europe/Paris → UTC+1 and UTC+2).
 *
 * The stored numeric spelling is always `UTC±N`; a `GMT±N` written by a sender
 * is treated as equivalent and normalized to `UTC` at lookup time, so it is not
 * stored separately.
 *
 * Pure data constant — no runtime lookups, no external dependencies.
 */
export interface TimeZoneEntry {
  readonly tzCode: string;
  readonly abbreviations: readonly string[];
}

export const TIMEZONE_ENTRIES: readonly TimeZoneEntry[] = [
  { tzCode: "Pacific/Niue", abbreviations: ["UTC-11"] },
  { tzCode: "Pacific/Pago_Pago", abbreviations: ["SST","UTC-11"] },
  { tzCode: "Pacific/Honolulu", abbreviations: ["HST","UTC-10"] },
  { tzCode: "Pacific/Rarotonga", abbreviations: ["UTC-10"] },
  { tzCode: "Pacific/Tahiti", abbreviations: ["UTC-10"] },
  { tzCode: "Pacific/Marquesas", abbreviations: ["UTC-9:30"] },
  { tzCode: "America/Anchorage", abbreviations: ["AKDT","AKST","UTC-9","UTC-8"] },
  { tzCode: "Pacific/Gambier", abbreviations: ["UTC-9"] },
  { tzCode: "America/Los_Angeles", abbreviations: ["PDT","PST","UTC-8","UTC-7"] },
  { tzCode: "America/Tijuana", abbreviations: ["PDT","PST","UTC-8","UTC-7"] },
  { tzCode: "America/Vancouver", abbreviations: ["MST","PDT","PST","UTC-8","UTC-7"] },
  { tzCode: "America/Whitehorse", abbreviations: ["MST","UTC-7"] },
  { tzCode: "Pacific/Pitcairn", abbreviations: ["UTC-8"] },
  { tzCode: "America/Denver", abbreviations: ["MDT","MST","UTC-7","UTC-6"] },
  { tzCode: "America/Phoenix", abbreviations: ["MST","UTC-7"] },
  { tzCode: "America/Mazatlan", abbreviations: ["MST","UTC-7"] },
  { tzCode: "America/Dawson_Creek", abbreviations: ["MST","UTC-7"] },
  { tzCode: "America/Edmonton", abbreviations: ["CST","MDT","MST","UTC-7","UTC-6"] },
  { tzCode: "America/Hermosillo", abbreviations: ["MST","UTC-7"] },
  { tzCode: "America/Yellowknife", abbreviations: ["CST","MDT","MST","UTC-7","UTC-6"] },
  { tzCode: "America/Belize", abbreviations: ["CST","UTC-6"] },
  { tzCode: "America/Chicago", abbreviations: ["CDT","CST","UTC-6","UTC-5"] },
  { tzCode: "America/Mexico_City", abbreviations: ["CST","UTC-6"] },
  { tzCode: "America/Regina", abbreviations: ["CST","UTC-6"] },
  { tzCode: "America/Tegucigalpa", abbreviations: ["CST","UTC-6"] },
  { tzCode: "America/Winnipeg", abbreviations: ["CDT","CST","UTC-6","UTC-5"] },
  { tzCode: "America/Costa_Rica", abbreviations: ["CST","UTC-6"] },
  { tzCode: "America/El_Salvador", abbreviations: ["CST","UTC-6"] },
  { tzCode: "Pacific/Galapagos", abbreviations: ["UTC-6"] },
  { tzCode: "America/Guatemala", abbreviations: ["CST","UTC-6"] },
  { tzCode: "America/Managua", abbreviations: ["CST","UTC-6"] },
  { tzCode: "America/Cancun", abbreviations: ["EST","UTC-5"] },
  { tzCode: "America/Bogota", abbreviations: ["UTC-5"] },
  { tzCode: "Pacific/Easter", abbreviations: ["UTC-5","UTC-6"] },
  { tzCode: "America/New_York", abbreviations: ["EDT","EST","UTC-5","UTC-4"] },
  { tzCode: "America/Iqaluit", abbreviations: ["EDT","EST","UTC-5","UTC-4"] },
  { tzCode: "America/Toronto", abbreviations: ["EDT","EST","UTC-5","UTC-4"] },
  { tzCode: "America/Guayaquil", abbreviations: ["UTC-5"] },
  { tzCode: "America/Havana", abbreviations: ["CDT","CST","UTC-5","UTC-4"] },
  { tzCode: "America/Jamaica", abbreviations: ["EST","UTC-5"] },
  { tzCode: "America/Lima", abbreviations: ["UTC-5"] },
  { tzCode: "America/Nassau", abbreviations: ["EDT","EST","UTC-5","UTC-4"] },
  { tzCode: "America/Panama", abbreviations: ["EST","UTC-5"] },
  { tzCode: "America/Port-au-Prince", abbreviations: ["EDT","EST","UTC-5","UTC-4"] },
  { tzCode: "America/Rio_Branco", abbreviations: ["UTC-5"] },
  { tzCode: "America/Halifax", abbreviations: ["ADT","AST","UTC-4","UTC-3"] },
  { tzCode: "America/Barbados", abbreviations: ["AST","UTC-4"] },
  { tzCode: "Atlantic/Bermuda", abbreviations: ["ADT","AST","UTC-4","UTC-3"] },
  { tzCode: "America/Boa_Vista", abbreviations: ["UTC-4"] },
  { tzCode: "America/Caracas", abbreviations: ["UTC-4"] },
  { tzCode: "America/Curacao", abbreviations: ["AST","UTC-4"] },
  { tzCode: "America/Grand_Turk", abbreviations: ["EDT","EST","UTC-5","UTC-4"] },
  { tzCode: "America/Guyana", abbreviations: ["UTC-4"] },
  { tzCode: "America/La_Paz", abbreviations: ["UTC-4"] },
  { tzCode: "America/Manaus", abbreviations: ["UTC-4"] },
  { tzCode: "America/Martinique", abbreviations: ["AST","UTC-4"] },
  { tzCode: "America/Port_of_Spain", abbreviations: ["AST","UTC-4"] },
  { tzCode: "America/Porto_Velho", abbreviations: ["UTC-4"] },
  { tzCode: "America/Puerto_Rico", abbreviations: ["AST","UTC-4"] },
  { tzCode: "America/Santo_Domingo", abbreviations: ["AST","UTC-4"] },
  { tzCode: "America/Thule", abbreviations: ["ADT","AST","UTC-4","UTC-3"] },
  { tzCode: "America/St_Johns", abbreviations: ["NDT","NST","UTC-3:30","UTC-2:30"] },
  { tzCode: "America/Araguaina", abbreviations: ["UTC-3"] },
  { tzCode: "America/Asuncion", abbreviations: ["UTC-3","UTC-4"] },
  { tzCode: "America/Belem", abbreviations: ["UTC-3"] },
  { tzCode: "America/Argentina/Buenos_Aires", abbreviations: ["UTC-3"] },
  { tzCode: "America/Campo_Grande", abbreviations: ["UTC-4"] },
  { tzCode: "America/Cayenne", abbreviations: ["UTC-3"] },
  { tzCode: "America/Cuiaba", abbreviations: ["UTC-4"] },
  { tzCode: "America/Fortaleza", abbreviations: ["UTC-3"] },
  { tzCode: "America/Godthab", abbreviations: ["UTC-2","UTC-1"] },
  { tzCode: "America/Maceio", abbreviations: ["UTC-3"] },
  { tzCode: "America/Miquelon", abbreviations: ["UTC-3","UTC-2"] },
  { tzCode: "America/Montevideo", abbreviations: ["UTC-3"] },
  { tzCode: "Antarctica/Palmer", abbreviations: ["UTC-3"] },
  { tzCode: "America/Paramaribo", abbreviations: ["UTC-3"] },
  { tzCode: "America/Punta_Arenas", abbreviations: ["UTC-3"] },
  { tzCode: "America/Recife", abbreviations: ["UTC-3"] },
  { tzCode: "Antarctica/Rothera", abbreviations: ["UTC-3"] },
  { tzCode: "America/Bahia", abbreviations: ["UTC-3"] },
  { tzCode: "America/Santiago", abbreviations: ["UTC-3","UTC-4"] },
  { tzCode: "Atlantic/Stanley", abbreviations: ["UTC-3"] },
  { tzCode: "America/Noronha", abbreviations: ["UTC-2"] },
  { tzCode: "America/Sao_Paulo", abbreviations: ["UTC-3"] },
  { tzCode: "Atlantic/South_Georgia", abbreviations: ["UTC-2"] },
  { tzCode: "Atlantic/Azores", abbreviations: ["UTC-1","UTC+0"] },
  { tzCode: "Atlantic/Cape_Verde", abbreviations: ["UTC-1"] },
  { tzCode: "America/Scoresbysund", abbreviations: ["UTC-1"] },
  { tzCode: "Africa/Abidjan", abbreviations: ["GMT","UTC+0"] },
  { tzCode: "Africa/Accra", abbreviations: ["GMT","UTC+0"] },
  { tzCode: "Africa/Bissau", abbreviations: ["GMT","UTC+0"] },
  { tzCode: "Atlantic/Canary", abbreviations: ["WEST","WET","UTC+0","UTC+1"] },
  { tzCode: "Africa/Casablanca", abbreviations: ["UTC+1"] },
  { tzCode: "America/Danmarkshavn", abbreviations: ["GMT","UTC+0"] },
  { tzCode: "Europe/Dublin", abbreviations: ["GMT","IST","UTC+0","UTC+1"] },
  { tzCode: "Africa/El_Aaiun", abbreviations: ["UTC+1"] },
  { tzCode: "Atlantic/Faroe", abbreviations: ["WEST","WET","UTC+0","UTC+1"] },
  { tzCode: "Etc/GMT", abbreviations: ["UTC+0"] },
  { tzCode: "Europe/Lisbon", abbreviations: ["WEST","WET","UTC+0","UTC+1"] },
  { tzCode: "Europe/London", abbreviations: ["BST","GMT","UTC+0","UTC+1"] },
  { tzCode: "Africa/Monrovia", abbreviations: ["GMT","UTC+0"] },
  { tzCode: "Atlantic/Reykjavik", abbreviations: ["GMT","UTC+0"] },
  { tzCode: "Africa/Algiers", abbreviations: ["CET","UTC+1"] },
  { tzCode: "Europe/Amsterdam", abbreviations: ["CEST","CET","UTC+1","UTC+2"] },
  { tzCode: "Europe/Andorra", abbreviations: ["CEST","CET","UTC+1","UTC+2"] },
  { tzCode: "Europe/Berlin", abbreviations: ["CEST","CET","UTC+1","UTC+2"] },
  { tzCode: "Europe/Brussels", abbreviations: ["CEST","CET","UTC+1","UTC+2"] },
  { tzCode: "Europe/Budapest", abbreviations: ["CEST","CET","UTC+1","UTC+2"] },
  { tzCode: "Europe/Belgrade", abbreviations: ["CEST","CET","UTC+1","UTC+2"] },
  { tzCode: "Europe/Prague", abbreviations: ["CEST","CET","UTC+1","UTC+2"] },
  { tzCode: "Africa/Ceuta", abbreviations: ["CEST","CET","UTC+1","UTC+2"] },
  { tzCode: "Europe/Copenhagen", abbreviations: ["CEST","CET","UTC+1","UTC+2"] },
  { tzCode: "Europe/Gibraltar", abbreviations: ["CEST","CET","UTC+1","UTC+2"] },
  { tzCode: "Africa/Lagos", abbreviations: ["WAT","UTC+1"] },
  { tzCode: "Europe/Luxembourg", abbreviations: ["CEST","CET","UTC+1","UTC+2"] },
  { tzCode: "Europe/Madrid", abbreviations: ["CEST","CET","UTC+1","UTC+2"] },
  { tzCode: "Europe/Malta", abbreviations: ["CEST","CET","UTC+1","UTC+2"] },
  { tzCode: "Europe/Monaco", abbreviations: ["CEST","CET","UTC+1","UTC+2"] },
  { tzCode: "Africa/Ndjamena", abbreviations: ["WAT","UTC+1"] },
  { tzCode: "Europe/Oslo", abbreviations: ["CEST","CET","UTC+1","UTC+2"] },
  { tzCode: "Europe/Paris", abbreviations: ["CEST","CET","UTC+1","UTC+2"] },
  { tzCode: "Europe/Rome", abbreviations: ["CEST","CET","UTC+1","UTC+2"] },
  { tzCode: "Europe/Stockholm", abbreviations: ["CEST","CET","UTC+1","UTC+2"] },
  { tzCode: "Europe/Tirane", abbreviations: ["CEST","CET","UTC+1","UTC+2"] },
  { tzCode: "Africa/Tunis", abbreviations: ["CET","UTC+1"] },
  { tzCode: "Europe/Vienna", abbreviations: ["CEST","CET","UTC+1","UTC+2"] },
  { tzCode: "Europe/Warsaw", abbreviations: ["CEST","CET","UTC+1","UTC+2"] },
  { tzCode: "Europe/Zurich", abbreviations: ["CEST","CET","UTC+1","UTC+2"] },
  { tzCode: "Asia/Amman", abbreviations: ["UTC+3"] },
  { tzCode: "Europe/Athens", abbreviations: ["EEST","EET","UTC+2","UTC+3"] },
  { tzCode: "Asia/Beirut", abbreviations: ["EEST","EET","UTC+2","UTC+3"] },
  { tzCode: "Europe/Bucharest", abbreviations: ["EEST","EET","UTC+2","UTC+3"] },
  { tzCode: "Africa/Cairo", abbreviations: ["EEST","EET","UTC+2","UTC+3"] },
  { tzCode: "Europe/Chisinau", abbreviations: ["EEST","EET","UTC+2","UTC+3"] },
  { tzCode: "Asia/Damascus", abbreviations: ["UTC+3"] },
  { tzCode: "Asia/Gaza", abbreviations: ["EEST","EET","UTC+2","UTC+3"] },
  { tzCode: "Europe/Helsinki", abbreviations: ["EEST","EET","UTC+2","UTC+3"] },
  { tzCode: "Asia/Jerusalem", abbreviations: ["IDT","IST","UTC+2","UTC+3"] },
  { tzCode: "Africa/Johannesburg", abbreviations: ["SAST","UTC+2"] },
  { tzCode: "Africa/Khartoum", abbreviations: ["CAT","UTC+2"] },
  { tzCode: "Europe/Kiev", abbreviations: ["EEST","EET","UTC+2","UTC+3"] },
  { tzCode: "Africa/Maputo", abbreviations: ["CAT","UTC+2"] },
  { tzCode: "Europe/Kaliningrad", abbreviations: ["EET","UTC+2"] },
  { tzCode: "Asia/Nicosia", abbreviations: ["EEST","EET","UTC+2","UTC+3"] },
  { tzCode: "Europe/Riga", abbreviations: ["EEST","EET","UTC+2","UTC+3"] },
  { tzCode: "Europe/Sofia", abbreviations: ["EEST","EET","UTC+2","UTC+3"] },
  { tzCode: "Europe/Tallinn", abbreviations: ["EEST","EET","UTC+2","UTC+3"] },
  { tzCode: "Africa/Tripoli", abbreviations: ["EET","UTC+2"] },
  { tzCode: "Europe/Vilnius", abbreviations: ["EEST","EET","UTC+2","UTC+3"] },
  { tzCode: "Africa/Windhoek", abbreviations: ["CAT","UTC+2"] },
  { tzCode: "Asia/Baghdad", abbreviations: ["UTC+3"] },
  { tzCode: "Europe/Istanbul", abbreviations: ["UTC+3"] },
  { tzCode: "Europe/Minsk", abbreviations: ["UTC+3"] },
  { tzCode: "Europe/Moscow", abbreviations: ["MSK","UTC+3"] },
  { tzCode: "Africa/Nairobi", abbreviations: ["EAT","UTC+3"] },
  { tzCode: "Asia/Qatar", abbreviations: ["UTC+3"] },
  { tzCode: "Asia/Riyadh", abbreviations: ["UTC+3"] },
  { tzCode: "Antarctica/Syowa", abbreviations: ["UTC+3"] },
  { tzCode: "Asia/Tehran", abbreviations: ["UTC+3:30"] },
  { tzCode: "Asia/Baku", abbreviations: ["UTC+4"] },
  { tzCode: "Asia/Dubai", abbreviations: ["UTC+4"] },
  { tzCode: "Indian/Mahe", abbreviations: ["UTC+4"] },
  { tzCode: "Indian/Mauritius", abbreviations: ["UTC+4"] },
  { tzCode: "Europe/Samara", abbreviations: ["UTC+4"] },
  { tzCode: "Indian/Reunion", abbreviations: ["UTC+4"] },
  { tzCode: "Asia/Tbilisi", abbreviations: ["UTC+4"] },
  { tzCode: "Asia/Yerevan", abbreviations: ["UTC+4"] },
  { tzCode: "Asia/Kabul", abbreviations: ["UTC+4:30"] },
  { tzCode: "Asia/Aqtau", abbreviations: ["UTC+5"] },
  { tzCode: "Asia/Aqtobe", abbreviations: ["UTC+5"] },
  { tzCode: "Asia/Ashgabat", abbreviations: ["UTC+5"] },
  { tzCode: "Asia/Dushanbe", abbreviations: ["UTC+5"] },
  { tzCode: "Asia/Karachi", abbreviations: ["PKT","UTC+5"] },
  { tzCode: "Indian/Kerguelen", abbreviations: ["UTC+5"] },
  { tzCode: "Indian/Maldives", abbreviations: ["UTC+5"] },
  { tzCode: "Antarctica/Mawson", abbreviations: ["UTC+5"] },
  { tzCode: "Asia/Yekaterinburg", abbreviations: ["UTC+5"] },
  { tzCode: "Asia/Tashkent", abbreviations: ["UTC+5"] },
  { tzCode: "Asia/Colombo", abbreviations: ["UTC+5:30"] },
  { tzCode: "Asia/Kolkata", abbreviations: ["IST","UTC+5:30"] },
  { tzCode: "Asia/Kathmandu", abbreviations: ["UTC+5:45"] },
  { tzCode: "Asia/Almaty", abbreviations: ["UTC+6","UTC+5"] },
  { tzCode: "Asia/Bishkek", abbreviations: ["UTC+6"] },
  { tzCode: "Indian/Chagos", abbreviations: ["UTC+6"] },
  { tzCode: "Asia/Dhaka", abbreviations: ["UTC+6"] },
  { tzCode: "Asia/Omsk", abbreviations: ["UTC+6"] },
  { tzCode: "Asia/Thimphu", abbreviations: ["UTC+6"] },
  { tzCode: "Antarctica/Vostok", abbreviations: ["UTC+5"] },
  { tzCode: "Indian/Cocos", abbreviations: ["UTC+6:30"] },
  { tzCode: "Asia/Yangon", abbreviations: ["UTC+6:30"] },
  { tzCode: "Asia/Bangkok", abbreviations: ["UTC+7"] },
  { tzCode: "Indian/Christmas", abbreviations: ["UTC+7"] },
  { tzCode: "Antarctica/Davis", abbreviations: ["UTC+7"] },
  { tzCode: "Asia/Saigon", abbreviations: ["UTC+7"] },
  { tzCode: "Asia/Hovd", abbreviations: ["UTC+7"] },
  { tzCode: "Asia/Jakarta", abbreviations: ["WIB","UTC+7"] },
  { tzCode: "Asia/Krasnoyarsk", abbreviations: ["UTC+7"] },
  { tzCode: "Asia/Brunei", abbreviations: ["UTC+8"] },
  { tzCode: "Asia/Shanghai", abbreviations: ["CST","UTC+8"] },
  { tzCode: "Asia/Choibalsan", abbreviations: ["UTC+8"] },
  { tzCode: "Asia/Hong_Kong", abbreviations: ["HKT","UTC+8"] },
  { tzCode: "Asia/Kuala_Lumpur", abbreviations: ["UTC+8"] },
  { tzCode: "Asia/Macau", abbreviations: ["CST","UTC+8"] },
  { tzCode: "Asia/Makassar", abbreviations: ["WITA","UTC+8"] },
  { tzCode: "Asia/Manila", abbreviations: ["PST","UTC+8"] },
  { tzCode: "Asia/Irkutsk", abbreviations: ["UTC+8"] },
  { tzCode: "Asia/Singapore", abbreviations: ["UTC+8"] },
  { tzCode: "Asia/Taipei", abbreviations: ["CST","UTC+8"] },
  { tzCode: "Asia/Ulaanbaatar", abbreviations: ["UTC+8"] },
  { tzCode: "Australia/Perth", abbreviations: ["AWST","UTC+8"] },
  { tzCode: "Asia/Pyongyang", abbreviations: ["KST","UTC+9"] },
  { tzCode: "Asia/Dili", abbreviations: ["UTC+9"] },
  { tzCode: "Asia/Jayapura", abbreviations: ["WIT","UTC+9"] },
  { tzCode: "Asia/Yakutsk", abbreviations: ["UTC+9"] },
  { tzCode: "Pacific/Palau", abbreviations: ["UTC+9"] },
  { tzCode: "Asia/Seoul", abbreviations: ["KST","UTC+9"] },
  { tzCode: "Asia/Tokyo", abbreviations: ["JST","UTC+9"] },
  { tzCode: "Australia/Darwin", abbreviations: ["ACST","UTC+9:30"] },
  { tzCode: "Antarctica/DumontDUrville", abbreviations: ["UTC+10"] },
  { tzCode: "Australia/Brisbane", abbreviations: ["AEST","UTC+10"] },
  { tzCode: "Pacific/Guam", abbreviations: ["ChST","UTC+10"] },
  { tzCode: "Asia/Vladivostok", abbreviations: ["UTC+10"] },
  { tzCode: "Pacific/Port_Moresby", abbreviations: ["UTC+10"] },
  { tzCode: "Pacific/Chuuk", abbreviations: ["UTC+10"] },
  { tzCode: "Australia/Adelaide", abbreviations: ["ACDT","ACST","UTC+10:30","UTC+9:30"] },
  { tzCode: "Antarctica/Casey", abbreviations: ["UTC+8"] },
  { tzCode: "Australia/Hobart", abbreviations: ["AEDT","AEST","UTC+11","UTC+10"] },
  { tzCode: "Australia/Sydney", abbreviations: ["AEDT","AEST","UTC+11","UTC+10"] },
  { tzCode: "Pacific/Efate", abbreviations: ["UTC+11"] },
  { tzCode: "Pacific/Guadalcanal", abbreviations: ["UTC+11"] },
  { tzCode: "Pacific/Kosrae", abbreviations: ["UTC+11"] },
  { tzCode: "Asia/Magadan", abbreviations: ["UTC+11"] },
  { tzCode: "Pacific/Norfolk", abbreviations: ["UTC+12","UTC+11"] },
  { tzCode: "Pacific/Noumea", abbreviations: ["UTC+11"] },
  { tzCode: "Pacific/Pohnpei", abbreviations: ["UTC+11"] },
  { tzCode: "Pacific/Funafuti", abbreviations: ["UTC+12"] },
  { tzCode: "Pacific/Kwajalein", abbreviations: ["UTC+12"] },
  { tzCode: "Pacific/Majuro", abbreviations: ["UTC+12"] },
  { tzCode: "Asia/Kamchatka", abbreviations: ["UTC+12"] },
  { tzCode: "Pacific/Nauru", abbreviations: ["UTC+12"] },
  { tzCode: "Pacific/Tarawa", abbreviations: ["UTC+12"] },
  { tzCode: "Pacific/Wake", abbreviations: ["UTC+12"] },
  { tzCode: "Pacific/Wallis", abbreviations: ["UTC+12"] },
  { tzCode: "Pacific/Auckland", abbreviations: ["NZDT","NZST","UTC+13","UTC+12"] },
  { tzCode: "Pacific/Enderbury", abbreviations: ["UTC+13"] },
  { tzCode: "Pacific/Fakaofo", abbreviations: ["UTC+13"] },
  { tzCode: "Pacific/Fiji", abbreviations: ["UTC+12"] },
  { tzCode: "Pacific/Tongatapu", abbreviations: ["UTC+13"] },
  { tzCode: "Pacific/Apia", abbreviations: ["UTC+13"] },
  { tzCode: "Pacific/Kiritimati", abbreviations: ["UTC+14"] },
];

let allowlistCache: ReadonlySet<string> | undefined;
/** Set of valid IANA tzCodes for API validation — memoized on first access. */
export function timezoneAllowlist(): ReadonlySet<string> {
  return (allowlistCache ??= new Set(TIMEZONE_ENTRIES.map((e) => e.tzCode)));
}

export const DEFAULT_TIMEZONE = "Europe/London";

import { DateTime } from "luxon";

/**
 * Preferred IANA zone for an abbreviation whose candidate zones resolve to more
 * than one offset (e.g. CST is US Central −06:00 but also China +08:00). Used
 * only when the account timezone is not itself a candidate. The choice reflects
 * the dominant real-world sender: US zones for the American abbreviations, Dublin
 * for IST (Irish Standard Time is the summer name Irish law uses).
 */
const AMBIGUOUS_ABBREVIATION_PREFERENCE: Record<string, string> = {
  CDT: "America/Chicago",
  CST: "America/Chicago",
  IST: "Europe/Dublin",
  MST: "America/Denver",
  PST: "America/Los_Angeles",
};

let abbreviationIndexCache: ReadonlyMap<string, readonly string[]> | undefined;
function abbreviationIndex(): ReadonlyMap<string, readonly string[]> {
  if (abbreviationIndexCache) return abbreviationIndexCache;
  const index = new Map<string, string[]>();
  for (const { tzCode, abbreviations } of TIMEZONE_ENTRIES) {
    for (const abbr of abbreviations) {
      if (!/^[A-Za-z]+$/.test(abbr)) continue;
      (index.get(abbr) ?? index.set(abbr, []).get(abbr)!).push(tzCode);
    }
  }
  return (abbreviationIndexCache = index);
}

/**
 * A zone abbreviation names a specific DST state, so its offset is fixed by the
 * abbreviation itself, not by the calendar date it is attached to: "PST" is
 * −08:00 even on a July email. Daylight/summer abbreviations are those ending in
 * "DT" (PDT, EDT, AEDT, …) plus the European summer names and British/Irish
 * summer time. Everything else is the standard (winter) name. Returns whether the
 * abbreviation denotes the summer state, so the resolver samples the candidate
 * zone in the matching season rather than on the parsed date.
 */
const SUMMER_ABBREVIATIONS = new Set(["CEST", "EEST", "WEST", "BST", "IST", "IDT"]);
function isSummerAbbreviation(abbr: string): boolean {
  const upper = abbr.toUpperCase();
  return /DT$/.test(upper) || SUMMER_ABBREVIATIONS.has(upper);
}

/** The zone's offset (minutes) in the season the abbreviation denotes, DST-correct via a sample date in that season. */
function seasonOffsetMinutes(tz: string, summer: boolean): number {
  const jan = DateTime.fromObject({ year: 2024, month: 1, day: 15, hour: 12 }, { zone: tz }).offset;
  const jul = DateTime.fromObject({ year: 2024, month: 7, day: 15, hour: 12 }, { zone: tz }).offset;
  const summerOffset = jul >= jan ? jul : jan;
  const winterOffset = jul >= jan ? jan : jul;
  return summer ? summerOffset : winterOffset;
}

/** Parses a numeric UTC/GMT zone token ("UTC+2", "GMT-5", "UTC+05:30", "UTC", "GMT") to offset minutes. */
function numericOffsetMinutes(token: string): number | null {
  const m = token.match(/^(?:UTC|GMT)?([+-])(\d{1,2})(?::?(\d{2}))?$/i);
  if (m) {
    const sign = m[1] === "-" ? -1 : 1;
    const hours = Number(m[2]);
    const minutes = m[3] ? Number(m[3]) : 0;
    return sign * (hours * 60 + minutes);
  }
  if (/^(?:UTC|GMT)$/i.test(token)) return 0;
  return null;
}

/**
 * Resolves a trailing timezone token from an email date ("CEST", "GMT+2", "PST")
 * to a UTC offset in minutes for the given instant. Returns null when the token
 * is not a recognized abbreviation or numeric zone.
 *
 * Numeric tokens (UTC±N / GMT±N, any spelling) are computed arithmetically.
 * Alphabetic abbreviations are resolved against the allowlist. The offset is
 * fixed by the abbreviation's own DST state (PST is −08:00, PDT is −07:00) — not
 * by the date it is attached to — so a candidate zone is sampled in the season
 * the abbreviation names. When the abbreviation maps to several zones with
 * different offsets (CST → US Central or China), the account timezone wins if it
 * is a candidate, otherwise the preferred zone above.
 */
export function resolveZoneOffsetMinutes(rawToken: string, accountTimezone: string): number | null {
  const token = rawToken.trim().replace(/^\(|\)$/g, "");
  const numeric = numericOffsetMinutes(token.replace(/^GMT/i, "UTC"));
  if (numeric !== null) return numeric;

  const upper = token.toUpperCase();
  const candidates = abbreviationIndex().get(upper);
  if (!candidates || candidates.length === 0) return null;

  const summer = isSummerAbbreviation(upper);
  const offsetFor = (tz: string): number => seasonOffsetMinutes(tz, summer);
  const distinctOffsets = new Set(candidates.map(offsetFor));
  if (distinctOffsets.size === 1) return offsetFor(candidates[0]!);

  if (candidates.includes(accountTimezone)) return offsetFor(accountTimezone);
  const preferred = AMBIGUOUS_ABBREVIATION_PREFERENCE[upper];
  if (preferred && candidates.includes(preferred)) return offsetFor(preferred);
  return null;
}
