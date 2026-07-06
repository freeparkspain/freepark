import * as Speech from 'expo-speech';
import { VOICE_IMMEDIATE_DISTANCE_M, VOICE_LOOKAHEAD_SECONDS } from '../constants/navigation';
import { formatDistanceEn } from './format';

// ─── VoiceGuidanceManager ─────────────────────────────────────────────────────
// Speaks staged English prompts for the upcoming maneuver and remembers what it
// has already said so nothing repeats. Four stages per maneuver:
//   role 0 — early warning (distance scales with speed, min ~500 m)
//   role 1 — ~200 m
//   role 2 — ~50 m
//   role 3 — at the maneuver ("now")
// Only the bracket the driver is currently inside is spoken, so when maneuvers
// are close together the far stages are naturally skipped (never four in a row).
//
// TTS language: prefers en-US, then en-GB, then any English voice; if the device
// has no English voice the manager degrades silently (UI text still shows).

type Stage = { role: number; text: string };

// Preference order for the spoken language (BCP-47), per the spec.
const PREFERRED_LANGS = ['en-US', 'en-GB', 'en'];

export class VoiceGuidanceManager {
  private muted = false;
  private available = true;
  private language = 'en-US';
  private voiceId: string | undefined;
  private languageResolved = false;
  /** Keys of already-spoken prompts: `${stepKey}:${role}`. */
  private readonly spoken = new Set<string>();

  constructor() {
    // Resolve the best English voice once, in the background. Speaking before it
    // resolves simply uses the en-US default, which every English device honours.
    void this.resolveLanguage();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.stopSpeaking();
  }

  isMuted(): boolean {
    return this.muted;
  }

  /** Call when a brand-new route is applied — forget prior prompts. */
  reset(): void {
    this.spoken.clear();
  }

  /** Cancel any in-progress utterance and free resources. */
  dispose(): void {
    this.stopSpeaking();
    this.spoken.clear();
  }

  /**
   * Decide + speak the appropriate prompt for the upcoming maneuver.
   * @param stepKey     stable id for the maneuver (e.g. its index in the route)
   * @param instruction the localized instruction text
   * @param distanceM   metres to the maneuver
   * @param speedMps    current speed (m/s) or null
   */
  maybeAnnounce(
    stepKey: string | number,
    instruction: string,
    distanceM: number,
    speedMps: number | null,
  ): void {
    if (this.muted || !this.available) return;

    const stage = this.pickStage(instruction, distanceM, speedMps);
    if (!stage) return;

    const key = `${stepKey}:${stage.role}`;
    if (this.spoken.has(key)) return;
    this.spoken.add(key);
    this.speak(stage.text);
  }

  /**
   * Speak an arbitrary phrase immediately, cancelling anything mid-utterance
   * (used for "Route recalculated." / arrival, where the previous announcement
   * is now outdated).
   */
  announceNow(text: string): void {
    if (this.muted || !this.available) return;
    this.stopSpeaking();
    this.speak(text);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private pickStage(
    instruction: string,
    distanceM: number,
    speedMps: number | null,
  ): Stage | null {
    // Early-warning distance grows with speed so highway prompts land in time.
    const early = Math.max(500, Math.round((speedMps ?? 0) * VOICE_LOOKAHEAD_SECONDS));

    if (distanceM <= VOICE_IMMEDIATE_DISTANCE_M) {
      return { role: 3, text: instruction };
    }
    if (distanceM <= 50) {
      return { role: 2, text: `In 50 meters, ${lower(instruction)}` };
    }
    if (distanceM <= 200) {
      return { role: 1, text: `In 200 meters, ${lower(instruction)}` };
    }
    if (distanceM <= early) {
      return { role: 0, text: `In ${formatDistanceEn(distanceM)}, ${lower(instruction)}` };
    }
    return null;
  }

  private async resolveLanguage(): Promise<void> {
    if (this.languageResolved) return;
    this.languageResolved = true;
    try {
      const voices = await Speech.getAvailableVoicesAsync();
      if (!voices || voices.length === 0) return; // keep en-US default
      for (const lang of PREFERRED_LANGS) {
        const match = voices.find(v =>
          v.language?.toLowerCase().startsWith(lang.toLowerCase()),
        );
        if (match) {
          this.language = match.language;
          this.voiceId = match.identifier;
          return;
        }
      }
      // No English voice at all — don't force one; let the OS default speak.
      // (We keep `available` true; speaking a non-English voice is better than
      // silence, and most devices ship at least one English voice.)
    } catch {
      // getAvailableVoicesAsync unsupported — stick with the en-US default.
    }
  }

  private speak(text: string): void {
    try {
      Speech.speak(text, {
        language: this.language,
        voice: this.voiceId,
        pitch: 1.0,
        rate: 1.0,
        onError: () => { this.available = false; },
      });
    } catch {
      // TTS unavailable on this device — degrade silently (UI still shows text).
      this.available = false;
    }
  }

  private stopSpeaking(): void {
    try {
      Speech.stop();
    } catch {
      /* ignore */
    }
  }
}

// Lower-case the first letter for mid-sentence prompts ("In 200 meters, turn…").
function lower(s: string): string {
  return s.length > 0 ? s[0].toLowerCase() + s.slice(1) : s;
}
