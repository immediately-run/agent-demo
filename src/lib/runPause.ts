// The hide→pause join for one run (R3-562 / AGENT_RUN_DURABILITY_SPEC §7
// R-ARD-20a), extracted from ConversationStage so the join is testable without
// a DOM — the stageSelection / createProjectionPublisher pattern. The host
// keeps a hidden region mounted and merely hidden on an activity switch, so a
// run is not torn down; but a loop executing where the user can neither see
// the transcript nor reach Stop breaks the loop observability contract
// (LLM_AND_AGENTS_SPEC §3.3), so it pauses at its next turn boundary and
// continues on reveal: nothing lost, no repair pass, no resume gate.
//
// Descriptive only: the visibility read grants nothing and gates nothing — it
// is one boolean about the host's own chrome, answered for every frame.
import { PauseController, isRegionHidden, onRegionVisibilityChange } from '@immediately-run/sdk';

/**
 * One pause source per run. Seeded from the visibility at kickoff — a run that
 * somehow starts hidden (R-ARD-15: no agent writes with no human present)
 * executes nothing until the reveal — then driven by the host's visibility
 * push for the run's life. `dispose()` unsubscribes; call it in the run's
 * `finally` so a finished run cannot be paused by a late push.
 */
export function createRunPause(): { pause: PauseController; dispose: () => void } {
  const pause = new PauseController();
  if (isRegionHidden()) pause.set(true);
  const off = onRegionVisibilityChange((hidden) => pause.set(hidden));
  return { pause, dispose: off };
}
