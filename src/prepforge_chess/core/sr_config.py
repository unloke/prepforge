from dataclasses import dataclass


@dataclass(frozen=True)
class SRConfig:
    correct_increment: float = 1.0
    score_cap: float = 10.0
    wrong_multiplier: float = 0.5
    retry_minutes: int = 10
    mastered_score_at: float = 7.0
    mastered_correct_attempts: int = 3
    weak_score_below: float = 5.0


SR_CONFIG = SRConfig()
