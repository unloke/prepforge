from dataclasses import dataclass

# Stored ``training_progress.state``: 0 before the first review, then FSRS's State values.
STATE_NEW = 0
STATE_LEARNING = 1
STATE_REVIEW = 2
STATE_RELEARNING = 3


@dataclass(frozen=True)
class SRConfig:
    # FSRS schedules each move so it is due when recall odds fall to this.
    desired_retention: float = 0.9
    # A first miss (or a lapse) comes back after this many minutes.
    learning_step_minutes: int = 10
    # Review-state moves this stable (days) count as mastered.
    mastered_stability_days: float = 21.0
    # Moves tried twice whose stability is still under a day (or that just lapsed) are weak.
    weak_stability_days: float = 1.0


SR_CONFIG = SRConfig()
