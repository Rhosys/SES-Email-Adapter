import { DateTime } from "luxon";
import type { Resource } from "../types/index.js";

// Collapses resources that represent the same real-world thing but were saved as separate
// DynamoDB items (distinct resourceKey) — most commonly "events", whose resourceKey falls back
// to free-text eventName and so can drift slightly between emails about the same event. This is
// the server-side counterpart of what the UI used to do ad hoc in its thread signal workflow
// (src/lib/resource-match.ts::workflowMatchesResource), moved here so every consumer of the
// resources API gets it for free.
//
// Match rule, scoped to same threadId + same workflow:
//   - title case-invariantly contains (or is contained by) the other's title, and
//   - if BOTH resources carry a displayDate, they must fall on the same UTC calendar day;
//     if either lacks one, the title match alone decides.

function isSubstringMatch(a: string, b: string): boolean {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  return la.includes(lb) || lb.includes(la);
}

function utcDayKey(input: string): string {
  return DateTime.fromISO(input, { zone: "utc" }).toFormat("yyyy-MM-dd");
}

function sameDay(a?: string, b?: string): boolean {
  if (!a || !b) return true;
  return utcDayKey(a) === utcDayKey(b);
}

function titlesMatch(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  return isSubstringMatch(a, b);
}

// Merges `other` into `target` in place: assets are unioned (dedup by type+rawValue), and
// whichever side was updated most recently wins on the display/status fields.
function mergeInto(target: Resource, other: Resource): void {
  for (const asset of other.assets) {
    if (!target.assets.some(a => a.type === asset.type && a.rawValue === asset.rawValue)) {
      target.assets.push(asset);
    }
  }
  if (other.updatedAt > target.updatedAt) {
    target.resourceKey = other.resourceKey;
    target.status = other.status;
    target.expectedResolutionDate = other.expectedResolutionDate;
    const displayDate = other.displayDate ?? target.displayDate;
    if (displayDate !== undefined) target.displayDate = displayDate;
    const title = other.title ?? target.title;
    if (title !== undefined) target.title = title;
    const description = other.description ?? target.description;
    if (description !== undefined) target.description = description;
    const resolvedAt = other.resolvedAt ?? target.resolvedAt;
    if (resolvedAt !== undefined) target.resolvedAt = resolvedAt;
    target.updatedAt = other.updatedAt;
  }
  if (other.createdAt < target.createdAt) target.createdAt = other.createdAt;
}

export function collapseResources(resources: readonly Resource[]): Resource[] {
  const groups = new Map<string, Resource[]>();
  for (const resource of resources) {
    const key = `${resource.threadId}#${resource.workflow}`;
    const group = groups.get(key);
    if (group) group.push(resource);
    else groups.set(key, [resource]);
  }

  const collapsed: Resource[] = [];
  for (const group of groups.values()) {
    const merged: Resource[] = [];
    for (const resource of group) {
      const match = merged.find(m => titlesMatch(m.title, resource.title) && sameDay(m.displayDate, resource.displayDate));
      if (match) mergeInto(match, resource);
      else merged.push({ ...resource, assets: [...resource.assets] });
    }
    collapsed.push(...merged);
  }
  return collapsed;
}
