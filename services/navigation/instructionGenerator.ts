// ─── English turn-by-turn instruction generator ──────────────────────────────
// Pure (no RN/Expo imports) so it is trivially unit-testable. Turns an OSRM
// maneuver (type + modifier + optional street/exit) into a natural English
// phrase. Always produces a valid instruction even when the street name is
// missing. Voice and on-screen text share this single source of truth.

interface ManeuverInput {
  type:        string;
  modifier?:   string | null;
  streetName?: string | null;
  exit?:       number | null;
}

// Directional phrasing for `turn`, keyed by modifier.
const TURN_BY_MODIFIER: Record<string, string> = {
  'left':         'Turn left',
  'right':        'Turn right',
  'slight left':  'Bear left',
  'slight right': 'Bear right',
  'sharp left':   'Turn sharply left',
  'sharp right':  'Turn sharply right',
  'straight':     'Continue straight',
  'uturn':        'Make a U-turn',
};

// "onto <street>" suffix, only when a street name is present.
function onto(streetName?: string | null): string {
  const name = streetName?.trim();
  return name ? ` onto ${name}` : '';
}

// "keep left/right/straight" wording for lane-style maneuvers.
function keepWord(modifier?: string | null): string {
  switch (modifier) {
    case 'left':
    case 'slight left':
    case 'sharp left':
      return 'left';
    case 'right':
    case 'slight right':
    case 'sharp right':
      return 'right';
    default:
      return 'straight';
  }
}

// Ordinal for roundabout exits, 1..9 then a numeric fallback ("11th").
const EXIT_ORDINAL = [
  '', 'first', 'second', 'third', 'fourth', 'fifth',
  'sixth', 'seventh', 'eighth', 'ninth',
];

function ordinal(n: number): string {
  if (n >= 1 && n < EXIT_ORDINAL.length) return EXIT_ORDINAL[n];
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  if (mod10 === 1) return `${n}st`;
  if (mod10 === 2) return `${n}nd`;
  if (mod10 === 3) return `${n}rd`;
  return `${n}th`;
}

function roundaboutPhrase(exit?: number | null): string {
  if (exit && exit > 0) {
    return `At the roundabout, take the ${ordinal(exit)} exit`;
  }
  return 'At the roundabout, continue';
}

/**
 * Build a localized (English) instruction for a maneuver.
 * Handles: depart, arrive, turn (+ all modifiers), continue/straight,
 * roundabout/rotary (+ exit), merge, on/off ramp, fork, end of road, new name.
 */
export function generateInstruction(m: ManeuverInput): string {
  const street = onto(m.streetName);

  switch (m.type) {
    case 'depart':
      return m.streetName?.trim()
        ? `Head out on ${m.streetName.trim()}`
        : 'Start driving';

    case 'arrive':
      return 'You have arrived at your destination';

    case 'turn': {
      const base = (m.modifier && TURN_BY_MODIFIER[m.modifier]) || 'Turn';
      return `${base}${street}`;
    }

    case 'continue':
      return m.modifier && m.modifier !== 'straight'
        ? `Keep ${keepWord(m.modifier)}${street}`
        : `Continue straight${street}`;

    case 'new name':
      return street ? `Continue${street}` : 'Continue straight';

    case 'merge':
      return `Merge ${keepWord(m.modifier)}${street}`;

    case 'on ramp':
      return `Take the ramp${street}`;

    case 'off ramp':
      return `Take the exit${street ? street : ` on the ${keepWord(m.modifier)}`}`;

    case 'fork':
      return `Keep ${keepWord(m.modifier)} at the fork${street}`;

    case 'end of road': {
      const dir = m.modifier === 'left' ? 'left'
        : m.modifier === 'right' ? 'right'
        : 'straight';
      return `At the end of the road, turn ${dir}${street}`;
    }

    case 'roundabout':
    case 'rotary':
    case 'roundabout turn': {
      return `${roundaboutPhrase(m.exit)}${street}`;
    }

    default:
      // Unknown/opaque maneuver — never produce an empty or misleading line.
      return m.streetName?.trim()
        ? `Continue on ${m.streetName.trim()}`
        : 'Continue';
  }
}
