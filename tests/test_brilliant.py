from prepforge_chess.core.models import (
    Color,
    EngineEvaluation,
    MaiaMovePrediction,
    MoveClassification,
)
from prepforge_chess.services.brilliant import (
    BRILLIANT_ELIGIBLE_CLASSIFICATIONS,
    BrilliantAnalyzer,
    BrilliantConfig,
)

# Arbitrary legal position/move — the analyzer never re-derives the played move's
# legality; it just asks the (fake) Maia adapter for the move's policy + value
# glance. The trap layer DOES push Maia's top-policy move on this board, so that
# move (`_HUMAN_MOVE`) must be legal here.
_FEN_BEFORE = "5rk1/pp4pp/4p3/2R3Q1/3n4/2q4r/P1P2PPP/5RK1 b - - 1 23"
_MOVE = "c3g3"
_HUMAN_MOVE = "a7a6"  # the move Maia thinks a human would naturally play instead


class _FakeMaia:
    """Returns a fixed (human_probability, win_chance_after) glance, and a fixed
    top-policy move so the analyzer can compute trap_gap."""

    name = "fake-maia"

    def __init__(self, *, human_probability: float, glance_wc: float,
                 top_move: str = _HUMAN_MOVE):
        self._p = human_probability
        self._g = glance_wc
        self._top_move = top_move

    def predictions(self, fen, *, rating=None):
        return [
            MaiaMovePrediction(fen=fen, move_uci=self._top_move, probability=0.5, rank=1)
        ]

    def move_assessment(self, fen, move_uci, *, rating=None):
        return (self._p, self._g)


class _FakeEngine:
    """Inert engine: every position evaluates to a fixed White-cp score, so the
    trap layer's eval of Maia's natural move is whatever the test dictates."""

    name = "fake-engine"

    def __init__(self, *, white_cp_after_human: int):
        self._cp = white_cp_after_human

    def evaluate_position(self, fen, config=None):
        return EngineEvaluation(engine=self.name, score_cp=self._cp)

    def analyze_position(self, fen, config=None):  # pragma: no cover - unused here
        raise NotImplementedError


def _sf(white_cp: int) -> EngineEvaluation:
    return EngineEvaluation(engine="stockfish", score_cp=white_cp)


def _analyzer(*, human_probability, glance_wc, top_move=_HUMAN_MOVE,
              engine_white_cp_after_human=600, with_engine=True, **kwargs):
    """Build an analyzer with a fake Maia and (by default) a fake engine whose
    eval of the human's natural move is bad for the mover (White +600 → Black,
    the mover, ~0.1), giving a large trap_gap unless a test says otherwise."""
    engine = _FakeEngine(white_cp_after_human=engine_white_cp_after_human) if with_engine else None
    return BrilliantAnalyzer(
        maia=_FakeMaia(human_probability=human_probability, glance_wc=glance_wc, top_move=top_move),
        engine=engine,
        **kwargs,
    )


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


def test_unintuitive_revealing_trapping_move_is_brilliant():
    # Humans rarely play it (0.00), Maia thinks Black looks bad (glance 0.05),
    # Stockfish truth says Black winning (~0.90), and the move a human would
    # naturally play (a7a6, evaluated as White +600 → Black ~0.1) throws it
    # away. All three layers pass.
    analyzer = _analyzer(human_probability=0.0, glance_wc=0.05)
    result = _evaluate(analyzer)
    assert result is not None
    assert result.is_brilliant
    assert result.reveal_score >= 0.30
    assert result.trap_gap is not None and result.trap_gap >= 0.05


def test_intuitive_move_is_not_brilliant():
    # A move humans easily find (e.g. an obvious fork): high human probability,
    # even with a big reveal and trap -> not brilliant.
    analyzer = _analyzer(human_probability=0.80, glance_wc=0.05)
    result = _evaluate(analyzer)
    assert result is not None
    assert not result.is_brilliant


def test_no_reveal_is_not_brilliant():
    # Unintuitive, but Maia already sees Black is winning at a glance (0.85):
    # no reveal, so not brilliant.
    analyzer = _analyzer(human_probability=0.0, glance_wc=0.85)
    result = _evaluate(analyzer)
    assert result is not None
    assert result.reveal_score < 0.30
    assert not result.is_brilliant


def test_no_trap_is_not_brilliant():
    # Unintuitive + big reveal, but the move a human would naturally play is just
    # as good (a7a6 also evaluated as Black ~0.90, like the played move): there
    # was no trap to avoid, so finding this move did not actually matter.
    analyzer = _analyzer(human_probability=0.0, glance_wc=0.05,
                         engine_white_cp_after_human=-600)
    result = _evaluate(analyzer)
    assert result is not None
    assert result.reveal_score >= 0.30
    assert result.trap_gap is not None and result.trap_gap < 0.05
    assert not result.is_brilliant


def test_no_engine_means_trap_unevaluable_and_not_brilliant():
    # With no engine AND no client-supplied trap_gap, the trap layer cannot be
    # evaluated and the move is not flagged (the degradation when neither source
    # is available).
    analyzer = _analyzer(human_probability=0.0, glance_wc=0.05, with_engine=False)
    result = _evaluate(analyzer)
    assert result is not None
    assert result.trap_gap is None
    assert not result.is_brilliant


class _ClientMaia:
    """A Maia stand-in shaped like ReplayMaia: it has no policy/engine, only the
    browser-computed move glance AND a precomputed trap_gap per (fen, uci)."""

    name = "client-maia"

    def __init__(self, *, human_probability, glance_wc, trap_gap):
        self._p = human_probability
        self._g = glance_wc
        self._trap = trap_gap

    def move_assessment(self, fen, move_uci, *, rating=None):
        return (self._p, self._g)

    def precomputed_trap_gap(self, fen, move_uci):
        return self._trap


def test_client_precomputed_trap_gap_used_without_engine():
    # The public browser flow: no server engine, but the client shipped trap_gap.
    # The analyzer must use that value (not the engine path) and flag the move.
    analyzer = BrilliantAnalyzer(
        maia=_ClientMaia(human_probability=0.0, glance_wc=0.05, trap_gap=0.20),
        engine=None,
    )
    result = _evaluate(analyzer)
    assert result is not None
    assert result.trap_gap == 0.20
    assert result.is_brilliant


def test_client_precomputed_trap_gap_below_threshold_not_brilliant():
    # A client trap_gap under min_trap_gap (0.05) fails the trap layer even though
    # the move is unintuitive and revealing.
    analyzer = BrilliantAnalyzer(
        maia=_ClientMaia(human_probability=0.0, glance_wc=0.05, trap_gap=0.01),
        engine=None,
    )
    result = _evaluate(analyzer)
    assert result is not None
    assert result.trap_gap == 0.01
    assert not result.is_brilliant


def test_client_trap_gap_takes_precedence_over_engine():
    # When BOTH a precomputed trap_gap and an engine are present, the client value
    # wins (the browser is the source of truth) — here it flips a would-be-brilliant
    # engine result to not-brilliant by supplying a sub-threshold trap_gap.
    analyzer = BrilliantAnalyzer(
        maia=_ClientMaia(human_probability=0.0, glance_wc=0.05, trap_gap=0.0),
        engine=_FakeEngine(white_cp_after_human=600),
    )
    result = _evaluate(analyzer)
    assert result is not None
    assert result.trap_gap == 0.0
    assert not result.is_brilliant


def test_trap_gap_zero_when_human_move_equals_played():
    # If Maia's top-policy move IS the played move, there is no natural
    # alternative to trap — trap_gap is 0 and the move is not brilliant.
    analyzer = _analyzer(human_probability=0.0, glance_wc=0.05, top_move=_MOVE)
    result = _evaluate(analyzer)
    assert result is not None
    assert result.trap_gap == 0.0
    assert not result.is_brilliant


def test_non_eligible_classifications_return_none():
    analyzer = _analyzer(human_probability=0.0, glance_wc=0.05)
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
    # below the 0.30 bar, so it is correctly rejected before the trap layer even
    # matters. glance_wc 0.66 mirrors the probed dud; truth ~0.86 (sf_after -800
    # below) gives reveal ~0.20.
    analyzer = _analyzer(human_probability=0.029, glance_wc=0.66)
    result = _evaluate(analyzer, sf_after_cp=-500, sf_before_cp=-500)
    assert result is not None
    assert result.reveal_score < 0.30
    assert not result.is_brilliant


def test_already_winning_sacrifice_still_brilliant():
    # A sound sacrifice is typically *already* winning by Stockfish truth (the
    # best-play eval contains the sac), and can even glance above 0.60 — like the
    # Immortal 11.Qxh7+ (glance ~0.61). There is no glance cap: as long as the
    # reveal clears 0.30 and the natural move is a trap, it stays brilliant. truth
    # ~0.975 (sf -1000) − glance 0.61 = reveal ~0.37; trap large (human move +600).
    analyzer = _analyzer(human_probability=0.003, glance_wc=0.61)
    result = _evaluate(analyzer, sf_after_cp=-1000, sf_before_cp=-1000)
    assert result is not None
    assert result.maia_glance_wc > 0.60
    assert result.reveal_score >= 0.30
    assert result.trap_gap is not None and result.trap_gap >= 0.05
    assert result.is_brilliant


def test_config_defaults():
    config = BrilliantConfig()
    assert config.rating == 1900
    assert config.max_human_probability == 0.10
    assert config.min_reveal_score == 0.30
    assert config.min_trap_gap == 0.05
    # The "sound" layer was removed in favour of trap_gap.
    assert not hasattr(config, "max_glance_win_chance")
    assert not hasattr(config, "min_high_win_chance")
    assert not hasattr(config, "max_high_drop_vs_before")
