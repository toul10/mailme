/**
 * Avatars: companies as rounded squares, people as circles, colour derived from the name (stable per name),
 * so the same customer is recognisable across the board, the drawer and the report.
 */
import type { CSSProperties } from "react";
import type { PersonRef } from "../../../src/server/api-types.js";

/** Stable hue 0–359 from a string (FNV-1a). */
export function hueOf(s: string): number {
  let h = 0x811c9dc5;
  for (const ch of s.toLowerCase()) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 360;
}

/** “Epsilon Theatre” → “ET”, “maria@abc-gr.example” → “MA”, “Nikos Pappas” → “NP” (any script). */
export function initials(name: string): string {
  const clean = name.includes("@") ? name.split("@")[0]!.replace(/[._-]+/g, " ") : name;
  const words = clean
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

const style = (name: string): CSSProperties => ({ "--h": String(hueOf(name)) }) as CSSProperties;

export function CompanyAvatar({ name, size = "md" }: { name: string; size?: "sm" | "md" | "lg" }) {
  return (
    <span className={`av av-co av-${size}`} style={style(name)} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

export function PersonAvatar({ person, name, size = "sm" }: { person?: PersonRef | null; name?: string | null; size?: "xs" | "sm" | "md" }) {
  if (person?.isOwner) {
    return (
      <span className={`av av-me av-${size}`} aria-hidden="true">
        You
      </span>
    );
  }
  const label = person?.name || person?.address || name || "?";
  return (
    <span className={`av av-person av-${size}`} style={style(label)} aria-hidden="true">
      {initials(label)}
    </span>
  );
}

/** Up to `max` overlapping people avatars, “+N” after. */
export function AvatarStack({ people, max = 4 }: { people: Array<{ key: string; person: PersonRef | null; name?: string | null }>; max?: number }) {
  const shown = people.slice(0, max);
  const more = people.length - shown.length;
  return (
    <span className="av-stack">
      {shown.map((p) => (
        <PersonAvatar key={p.key} person={p.person} name={p.name} size="sm" />
      ))}
      {more > 0 ? <span className="av av-sm av-more">+{more}</span> : null}
    </span>
  );
}
