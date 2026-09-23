// R3-560 / R-ARD-15 — the attended-resume affordance, extracted (R3-695) so the
// §5.3 disposition's shape is testable: the offered choices are EXACTLY TWO
// ("resume", "keep the files and end the run"), the file-changes-stay copy is
// said plainly, and the third spec'd choice — discard the tail AND revert the
// run's writes — is NOT offered (disposition of 2026-09-15: the app cannot
// bound which writes were one run's, so a discard button would silently keep
// the files — the rev-2 trap). AGENT_RUN_DURABILITY_SPEC §5.3 is the single
// source; this component renders it and adds nothing.
interface ResumeAffordanceProps {
  /** R3-560: the journal depth above the fold — "interrupted after N steps". */
  journalDepth: number;
  onResume: () => void;
  onKeepAndEnd: () => void;
}

export default function ResumeAffordance({ journalDepth, onResume, onKeepAndEnd }: ResumeAffordanceProps) {
  return (
    <div className="ca-line ca-error" role="status">
      <span className="ca-err">
        This run was interrupted after {journalDepth} steps. You can resume it from its last checkpoint — either
        way, the file changes so far stay.
      </span>
      <div className="ca-resume-row">
        <button type="button" className="ca-run" onClick={onResume}>
          Resume run
        </button>
        <button type="button" className="ca-steer-btn" onClick={onKeepAndEnd}>
          Keep the files and end the run
        </button>
      </div>
    </div>
  );
}
