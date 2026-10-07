from prepforge_chess.core.models import (
    Color,
    EngineEvaluation,
    MoveClassification,
)
from prepforge_chess.services.brilliant import (
    BRILLIANT_ELIGIBLE_CLASSIFICATIONS,
    BrilliantAnalyzer,
    BrilliantConfig,
    material_invested,
)

# Arbitrary legal position/move — the analyzer never re-derives the played move's
# legality; it just asks the (fake) Maia adapter for the move's policy + value
# glance. The trap layer DOES push Maia's top-policy move on this board, so that
# move (`_HUMAN_MOVE`) must be legal here.
_FEN_BEFORE = "5rk1/pp4pp/4p3/2R3Q1/3n4/2q4r/P1P2PPP/5RK1 b - - 1 23"
_MOVE = "c3g3"
_HUMAN_MOVE = "a7a6"  # the move Maia thinks a human would naturally play instead
# Marshall's 23...Qg3 is a queen sacrifice: the engine's reply hxg3 takes it.
_REPLY = "h2g3"


def _sf(white_cp: int, pv=None) -> EngineEvaluation:
    return EngineEvaluation(engine="stockfish", score_cp=white_cp, pv=list(pv or []))


def _analyzer(*, human_probability, glance_wc, top_move=_HUMAN_MOVE,
              engine_white_cp_after_human=600, with_engine=True, **kwargs):
    """Build an analyzer with a fake Maia and (by default) a fake engine whose
    eval of the human's natural move is bad for the mover (White +600 → Black,
    the mover, ~0.1), giving a large trap_gap unless a test says otherwise."""
    from prepforge_chess.services.classification import win_chance_for_side
    trap = None if not with_engine else (0.0 if top_move == _MOVE else
        win_chance_for_side(_sf(-600), Color.BLACK) -
        win_chance_for_side(_sf(engine_white_cp_after_human), Color.BLACK))
    return BrilliantAnalyzer(
        maia=_ClientMaia(human_probability=human_probability, glance_wc=glance_wc, trap_gap=trap),
        **kwargs,
    )


def _evaluate(analyzer, classification=MoveClassification.BEST, *, sf_after_cp=-600,
              sf_before_cp=-600, reply=_REPLY):
    # Black to move; negative White cp = Black (mover) winning.
    return analyzer.evaluate(
        classification=classification,
        fen_before=_FEN_BEFORE,
        played_move_uci=_MOVE,
        side_to_move=Color.BLACK,
        stockfish_eval_before=_sf(sf_before_cp),
        stockfish_eval_after=_sf(sf_after_cp, [reply] if reply else []),
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

    def __init__(self, *, human_probability, glance_wc, trap_gap, only_move_gap=None, two_move_gap=None):
        self._p = human_probability
        self._g = glance_wc
        self._trap = trap_gap
        self._only = only_move_gap
        self._two = two_move_gap

    def move_assessment(self, fen, move_uci, *, rating=None):
        return (self._p, self._g)

    def precomputed_trap_gap(self, fen, move_uci):
        return self._trap

    def precomputed_only_move_gap(self, fen, move_uci):
        return self._only

    def precomputed_two_move_gap(self, fen, move_uci):
        return self._two


def test_client_precomputed_trap_gap_used_without_engine():
    # The public browser flow: no server engine, but the client shipped trap_gap.
    # The analyzer must use that value (not the engine path) and flag the move.
    analyzer = BrilliantAnalyzer(
        maia=_ClientMaia(human_probability=0.0, glance_wc=0.05, trap_gap=0.20),
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
    )
    result = _evaluate(analyzer)
    assert result is not None
    assert result.trap_gap == 0.01
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
        maia=_ClientMaia(human_probability=0.0, glance_wc=0.05, trap_gap=0.2),
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


# ---- Layer 4: an only move, or a sacrifice --------------------------------------

# A drawn R vs R+2P ending (user report, 66.Re8): Maia puts 83% on Rf1+, which loses,
# but eight quiet rook moves hold the draw equally well. Re8 is one of them.
_RE8_FEN = "8/8/8/5p2/5krp/7K/8/4R3 w - - 0 66"


def _quiet_evaluate(analyzer, *, only_move_gap_engine=None):
    return analyzer.evaluate(
        classification=MoveClassification.BEST,
        fen_before=_RE8_FEN,
        played_move_uci="e1e8",
        side_to_move=Color.WHITE,
        stockfish_eval_before=_sf(-5),
        stockfish_eval_after=_sf(-5, ["g4g3"]),
    )


def test_material_invested_counts_the_reply():
    assert material_invested(_FEN_BEFORE, _MOVE, _REPLY) == 9
    assert material_invested(_FEN_BEFORE, _MOVE, None) == 0
    assert material_invested(_RE8_FEN, "e1e8", "g4g3") == 0
    assert material_invested(_FEN_BEFORE, "zzzz", _REPLY) == 0


def test_one_of_many_holding_moves_is_not_brilliant():
    # All three Maia/Stockfish layers pass, but the move is neither an only move
    # (gap 0.006 to Re7) nor a sacrifice.
    analyzer = BrilliantAnalyzer(
        maia=_ClientMaia(human_probability=0.02, glance_wc=0.10, trap_gap=0.30, only_move_gap=0.006),
    )
    result = _quiet_evaluate(analyzer)
    assert result is not None
    assert result.reveal_score >= 0.30 and result.trap_gap >= 0.05
    assert result.sacrifice == 0
    assert not result.is_brilliant
    # ...it is still a hard find, so it is Great.
    assert result.is_great


def test_quiet_only_move_is_brilliant():
    analyzer = BrilliantAnalyzer(
        maia=_ClientMaia(human_probability=0.02, glance_wc=0.10, trap_gap=0.30, only_move_gap=0.20),
    )
    result = _quiet_evaluate(analyzer)
    assert result.only_move_gap == 0.20
    assert result.is_brilliant


def test_quiet_move_without_only_move_gap_fails_closed():
    analyzer = BrilliantAnalyzer(
        maia=_ClientMaia(human_probability=0.02, glance_wc=0.10, trap_gap=0.30),
    )
    result = _quiet_evaluate(analyzer)
    assert result.only_move_gap is None
    assert not result.is_brilliant


def test_sacrifice_passes_without_only_move_gap():
    # Marshall's Qg3 has other winning moves (gap ~0.02); the queen sacrifice carries it.
    analyzer = BrilliantAnalyzer(
        maia=_ClientMaia(human_probability=0.0, glance_wc=0.05, trap_gap=0.20, only_move_gap=0.02),
    )
    result = _evaluate(analyzer)
    assert result.sacrifice == 9
    assert result.is_brilliant
    no_reply = _evaluate(analyzer, reply=None)
    assert no_reply.sacrifice == 0
    assert not no_reply.is_brilliant


def test_config_layer_four_defaults():
    config = BrilliantConfig()
    assert config.min_only_move_gap == 0.05
    assert config.great_max_human_probability == 0.35
    assert config.great_min_trap_gap == 0.10
    assert config.great_min_two_move_gap == 0.10
    assert config.min_sacrifice == 2


def test_brilliant_is_never_also_great():
    analyzer = BrilliantAnalyzer(
        maia=_ClientMaia(human_probability=0.02, glance_wc=0.10, trap_gap=0.30, only_move_gap=0.20, two_move_gap=0.30),
    )
    result = _quiet_evaluate(analyzer)
    assert result.is_brilliant and not result.is_great


def _critical(**overrides):
    # A fairly expected move (25%) with no reveal, but the move a human would naturally
    # play throws 20 points away and only one other move comes close.
    values = dict(human_probability=0.25, glance_wc=0.80, trap_gap=0.20, only_move_gap=0.03, two_move_gap=0.25)
    values.update(overrides)
    return BrilliantAnalyzer(maia=_ClientMaia(**values))


def test_critical_find_is_great():
    result = _evaluate(_critical(), reply=None)
    assert not result.is_brilliant
    assert result.is_great


def test_critical_find_needs_a_clear_gap_to_the_third_move():
    assert not _evaluate(_critical(two_move_gap=0.09), reply=None).is_great
    assert not _evaluate(_critical(two_move_gap=None), reply=None).is_great


def test_critical_find_needs_the_natural_move_to_fail():
    # Two good moves and the natural one is among them: avoiding nothing, so not Great.
    assert not _evaluate(_critical(trap_gap=0.05), reply=None).is_great
    assert not _evaluate(_critical(trap_gap=None), reply=None).is_great


def test_critical_find_needs_an_unexpected_move():
    assert not _evaluate(_critical(human_probability=0.50), reply=None).is_great


def test_critical_find_needs_a_live_position():
    # Still lost after the move (White +6 against Black to move) …
    assert not _evaluate(_critical(), reply=None, sf_after_cp=600, sf_before_cp=600).is_great
    # … or already decided before it.
    assert not _evaluate(_critical(), reply=None, sf_after_cp=-1500, sf_before_cp=-1500).is_great


def test_apply_brilliant_result_sets_great_with_evidence():
    from prepforge_chess.services.brilliant import apply_brilliant_result

    class _Move:
        classification = MoveClassification.BEST

    move = _Move()
    result = _evaluate(_critical(), reply=None)
    comment = apply_brilliant_result(move, result, "Best move")
    assert move.classification is MoveClassification.GREAT
    assert comment.startswith("Best move (great: ") and "two-move gap +0.25" in comment
    plain = _Move()
    assert apply_brilliant_result(plain, None, "Best move") == "Best move"
    assert plain.classification is MoveClassification.BEST


def test_recapture_of_the_previous_move_is_never_graded():
    # Every layer would pass, but the move takes back on the square the opponent just
    # captured on: an obvious reply, not a find.
    analyzer = _analyzer(human_probability=0.0, glance_wc=0.05)
    fen_prev = "rnbqkbnr/ppp2ppp/8/3pp3/4P3/2N5/PPPP1PPP/R1BQKBNR w KQkq - 0 3"
    board_fen = "rnbqkbnr/ppp2ppp/8/3Np3/4P3/8/PPPP1PPP/R1BQKBNR b KQkq - 0 3"
    common = dict(
        classification=MoveClassification.BEST,
        fen_before=board_fen,
        played_move_uci="d8d5",
        side_to_move=Color.BLACK,
        stockfish_eval_before=_sf(-600),
        stockfish_eval_after=_sf(-600),
    )
    assert analyzer.evaluate(**common, previous_fen_before=fen_prev, previous_move_uci="c3d5") is None
    # Without the previous move (or after a non-capture) the gate stays open.
    assert analyzer.evaluate(**common) is not None
