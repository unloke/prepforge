from prepforge_chess.core.models import Color, EngineEvaluation, MoveClassification
from prepforge_chess.services.brilliant import (
    BRILLIANT_ELIGIBLE_CLASSIFICATIONS,
    BrilliantAnalyzer,
    BrilliantConfig,
)

# Arbitrary legal position/move — the analyzer never re-derives legality; it
# just asks the (fake) Maia adapter for the move's policy + value glance.
_FEN_BEFORE = "5rk1/pp4pp/4p3/2R3Q1/3n4/2q4r/P1P2PPP/5RK1 b - - 1 23"
_MOVE = "c3g3"


class _FakeMaia:
    """Returns a fixed (human_probability, win_chance_after) glance."""

    name = "fake-maia"

    def __init__(self, *, human_probability: float, glance_wc: float):
        self._p = human_probability
        self._g = glance_wc

    def predictions(self, fen, *, rating=None):
        return []

    def move_assessment(self, fen, move_uci, *, rating=None):
        return (self._p, self._g)


def _sf(white_cp: int) -> EngineEvaluation:
    return EngineEvaluation(engine="stockfish", score_cp=white_cp)


def _evaluate(analyzer, classification=MoveClassification.BEST, *, sf_after_cp=-600,
              sf_before_cp=-600):
    # Black to move; negative White cp = Black (mover) winning.
    return analyzer.evaluate(
        classification=classification,
        fen_before=_FEN_BEFORE,
        played_move_uci=_MOVE,
        side_to_move=Color.BLACK,
        stockfish_eval_before=_sf(sf_before_cp),
        stockfish_eval_after=_sf(sf_after_cp),
    )


def test_eligible_classifications_are_best_and_excellent_only():
    assert BRILLIANT_ELIGIBLE_CLASSIFICATIONS == frozenset(
        {MoveClassification.BEST, MoveClassification.EXCELLENT}
    )


def test_unintuitive_surprising_sound_move_is_brilliant():
    # Humans rarely play it (0.00), Maia thinks Black looks bad (glance 0.05),
    # Stockfish truth says Black winning (~0.90). All three layers pass.
    analyzer = BrilliantAnalyzer(maia=_FakeMaia(human_probability=0.0, glance_wc=0.05))
    result = _evaluate(analyzer)
    assert result is not None
    assert result.is_brilliant
    assert result.reveal_score >= 0.30


def test_intuitive_move_is_not_brilliant():
    # A move humans easily find (e.g. an obvious fork): high human probability,
    # even with a big reveal -> not brilliant.
    analyzer = BrilliantAnalyzer(maia=_FakeMaia(human_probability=0.80, glance_wc=0.05))
    result = _evaluate(analyzer)
    assert result is not None
    assert not result.is_brilliant


def test_no_reveal_is_not_brilliant():
    # Unintuitive, but Maia already sees Black is winning at a glance (0.85):
    # no reveal, so not brilliant.
    analyzer = BrilliantAnalyzer(maia=_FakeMaia(human_probability=0.0, glance_wc=0.85))
    result = _evaluate(analyzer)
    assert result is not None
    assert result.reveal_score < 0.30
    assert not result.is_brilliant


def test_unsound_move_is_not_brilliant():
    # Unintuitive + big reveal, but the Stockfish truth keeps Black losing.
    analyzer = BrilliantAnalyzer(maia=_FakeMaia(human_probability=0.0, glance_wc=0.05))
    result = _evaluate(analyzer, sf_after_cp=300, sf_before_cp=300)  # White winning
    assert result is not None
    assert result.sf_truth_wc < 0.50
    assert not result.is_brilliant


def test_non_eligible_classifications_return_none():
    analyzer = BrilliantAnalyzer(maia=_FakeMaia(human_probability=0.0, glance_wc=0.05))
    for classification in (
        MoveClassification.GOOD,
        MoveClassification.INACCURACY,
        MoveClassification.MISTAKE,
        MoveClassification.BLUNDER,
    ):
        assert _evaluate(analyzer, classification) is None


def test_returns_none_without_maia():
    analyzer = BrilliantAnalyzer(maia=None)
    assert _evaluate(analyzer) is None


def test_returns_none_when_maia_cannot_assess():
    class _NoAssessMaia:
        name = "x"

        def predictions(self, fen, *, rating=None):
            return []

        def move_assessment(self, fen, move_uci, *, rating=None):
            return None

    analyzer = BrilliantAnalyzer(maia=_NoAssessMaia())
    assert _evaluate(analyzer) is None


def test_returns_none_when_disabled():
    analyzer = BrilliantAnalyzer(
        maia=_FakeMaia(human_probability=0.0, glance_wc=0.05),
        config=BrilliantConfig(enabled=False),
    )
    assert _evaluate(analyzer) is None


def test_pawn_race_dilution_dud_is_not_brilliant():
    # The real-world false positive: in a chaotic pawn race several rook moves are
    # roughly equal, so Maia's policy mass is spread thin (low human_probability)
    # without the move hiding anything. Its reveal is modest (~0.20) and falls
    # below the 0.30 bar, so it is correctly rejected. glance_wc 0.66 mirrors the
    # probed dud; truth ~0.86 (sf_after -800 below) gives reveal ~0.20.
    analyzer = BrilliantAnalyzer(maia=_FakeMaia(human_probability=0.029, glance_wc=0.66))
    result = _evaluate(analyzer, sf_after_cp=-500, sf_before_cp=-500)
    assert result is not None
    assert result.reveal_score < 0.30
    assert not result.is_brilliant


def test_already_winning_sacrifice_still_brilliant():
    # A sound sacrifice is typically *already* winning by Stockfish truth (the
    # best-play eval contains the sac), and can even glance above 0.60 — like the
    # Immortal 11.Qxh7+ (glance ~0.61). There is no glance cap: as long as the
    # reveal clears 0.30 it stays brilliant. truth ~0.975 (sf -1000) − glance 0.61
    # = reveal ~0.37.
    analyzer = BrilliantAnalyzer(maia=_FakeMaia(human_probability=0.003, glance_wc=0.61))
    result = _evaluate(analyzer, sf_after_cp=-1000, sf_before_cp=-1000)
    assert result is not None
    assert result.maia_glance_wc > 0.60
    assert result.reveal_score >= 0.30
    assert result.is_brilliant


def test_config_defaults():
    config = BrilliantConfig()
    assert config.rating == 1900
    assert config.max_human_probability == 0.10
    assert config.min_reveal_score == 0.30
    assert not hasattr(config, "max_glance_win_chance")
    assert config.min_high_win_chance == 0.50
    assert config.max_high_drop_vs_before == 0.05
