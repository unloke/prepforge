from __future__ import annotations

import argparse
from pathlib import Path
from typing import Callable, List, Optional, Sequence, Tuple

from prepforge_chess.core.chess_core import ChessCore
from prepforge_chess.services.analysis import AnalysisConfig, AnalysisProgress, AnalysisService
from prepforge_chess.services.analysis_report import AnalysisReportBuilder
from prepforge_chess.core.models import Color, MoveSource, TrainingMode
from prepforge_chess.services.engine import EngineAdapter, EngineAnalysisConfig, MockEngine, StockfishEngine
from prepforge_chess.services.game_navigation import GameNavigationService
from prepforge_chess.services.opening_builder import (
    CreateRepertoireRequest,
    OpeningBuilderService,
    OpeningTreeReport,
)
from prepforge_chess.services.opening_generation import GenerateConfig
from prepforge_chess.services.maia import create_maia3_adapter
from prepforge_chess.services.pgn_import import PgnImportService
from prepforge_chess.services.repertoire_export import RepertoireExportService
from prepforge_chess.services.stockfish_download import (
    find_stockfish_executable,
    install_stockfish,
)
from prepforge_chess.services.training import TrainingService
from prepforge_chess.storage.database import apply_schema, connect_database
from prepforge_chess.storage.repositories import PrepForgeRepository
from prepforge_chess.ui.terminal_viewer import TerminalBoardRenderer, TerminalGameViewer
from prepforge_chess.ui.analysis_terminal import TerminalAnalysisRenderer
from prepforge_chess.web.server import DEFAULT_DB_PATH, run_web_server


SMOKE_PGN = """
[Event "PrepForge Smoke"]
[Site "https://lichess.org/prepforge1"]
[Date "2026.05.25"]
[White "SmokeWhite"]
[Black "SmokeBlack"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0
"""


def run_smoke() -> int:
    connection = connect_database()
    apply_schema(connection)
    repository = PrepForgeRepository(connection)

    import_result = PgnImportService(repository).import_text(SMOKE_PGN)
    if import_result.errors or not import_result.imported_game_ids:
        print("smoke: failed")
        for error in import_result.errors:
            print("error: {0}".format(error))
        return 1

    game_id = import_result.imported_game_ids[0]
    navigator = GameNavigationService(repository)
    state = navigator.state_for_game_id(game_id, ply=4)

    print("smoke: ok")
    print("imported_games: {0}".format(import_result.imported_count))
    print("game_id: {0}".format(game_id))
    print("current_ply: {0}/{1}".format(state.current_ply, state.total_plies))
    print("fen: {0}".format(state.board_state.fen))
    print("last_move: {0}".format(state.board_state.last_move_uci))
    print("legal_moves: {0}".format(len(state.board_state.legal_moves)))
    print("next_move: {0}".format(state.next_move.uci if state.next_move else "none"))
    return 0


def _repository_from_pgn(pgn_text: str) -> Tuple[PrepForgeRepository, str]:
    connection = connect_database()
    apply_schema(connection)
    repository = PrepForgeRepository(connection)
    import_result = PgnImportService(repository).import_text(pgn_text)
    if import_result.errors:
        raise ValueError("; ".join(import_result.errors))
    if not import_result.imported_game_ids:
        raise ValueError("No game imported.")
    return repository, import_result.imported_game_ids[0]


def run_viewer(
    *,
    pgn_text: str,
    ply: int,
    flipped: bool,
    interactive: bool,
) -> int:
    try:
        repository, game_id = _repository_from_pgn(pgn_text)
        navigation = GameNavigationService(repository)
        if interactive:
            return TerminalGameViewer(navigation, game_id).run(initial_ply=ply, flipped=flipped)

        state = navigation.state_for_game_id(game_id, ply=ply)
        print(TerminalBoardRenderer().render(state))
        return 0
    except Exception as exc:
        print("viewer: failed")
        print("error: {0}".format(exc))
        return 1


def run_demo_viewer(args: argparse.Namespace) -> int:
    return run_viewer(
        pgn_text=SMOKE_PGN,
        ply=args.ply,
        flipped=args.flipped,
        interactive=args.interactive,
    )


def run_pgn_viewer(args: argparse.Namespace) -> int:
    with open(args.path, "r", encoding="utf-8") as file:
        pgn_text = file.read()
    return run_viewer(
        pgn_text=pgn_text,
        ply=args.ply,
        flipped=args.flipped,
        interactive=args.interactive,
    )


def run_analysis(
    *,
    pgn_text: str,
    depth: int,
    engine_name: str,
    stockfish_path: Optional[str] = None,
    install_missing_stockfish: bool = False,
    show_progress: bool = False,
    workers: int = 1,
) -> int:
    engine: Optional[EngineAdapter] = None
    try:
        repository, game_id = _repository_from_pgn(pgn_text)
        engine_factory = None
        service_engine_name = None

        if workers > 1:
            engine_factory, service_engine_name = _create_engine_factory(
                engine_name=engine_name,
                stockfish_path=stockfish_path,
                install_missing_stockfish=install_missing_stockfish,
            )
            service = AnalysisService(
                repository,
                engine_factory=engine_factory,
                engine_name=service_engine_name,
            )
        else:
            engine = _create_engine(
                engine_name=engine_name,
                stockfish_path=stockfish_path,
                install_missing_stockfish=install_missing_stockfish,
            )
            service = AnalysisService(repository, engine=engine)

        result = service.analyze_game_id(
            game_id,
            config=AnalysisConfig(
                engine=EngineAnalysisConfig(depth=depth, multipv=1),
                max_workers=max(1, workers),
            ),
            progress_callback=_print_analysis_progress if show_progress else None,
        )
        print("analysis: ok")
        print("engine: {0}".format(result.engine))
        print("depth: {0}".format(result.depth))
        print("workers: {0}".format(max(1, workers)))
        print("game_id: {0}".format(game_id))
        print("summary: {0}".format(_format_summary(result.summary)))
        if result.critical_ply:
            print("critical_ply: {0}".format(" ".join(str(ply) for ply in result.critical_ply)))
        report = AnalysisReportBuilder().build(result)
        print("")
        print(TerminalAnalysisRenderer().render(report))
        print("")
        print("moves:")
        for move in result.move_results:
            eval_cp = move.engine_eval_after.score_cp if move.engine_eval_after else None
            best = move.best_move_uci or "-"
            print(
                "  {0:>2}. {1:<8} {2:<12} best={3:<5} eval={4}".format(
                    move.ply,
                    move.san,
                    move.classification.value,
                    best,
                    eval_cp if eval_cp is not None else "-",
                )
            )
        return 0
    except Exception as exc:
        print("analysis: failed")
        print("error: {0}".format(exc))
        return 1
    finally:
        if isinstance(engine, StockfishEngine):
            engine.close()


def _create_engine(
    *,
    engine_name: str,
    stockfish_path: Optional[str],
    install_missing_stockfish: bool,
) -> EngineAdapter:
    if engine_name == "mock":
        return MockEngine()
    if engine_name == "stockfish":
        path = stockfish_path or find_stockfish_executable()
        if path is None and install_missing_stockfish:
            path = install_stockfish().executable_path
        if path is None:
            raise FileNotFoundError(
                "Stockfish executable not found. Run `prepforge-chess install-stockfish` "
                "or pass `--stockfish-path`."
            )
        return StockfishEngine(path)
    raise ValueError("unknown engine: {0}".format(engine_name))


def _create_engine_factory(
    *,
    engine_name: str,
    stockfish_path: Optional[str],
    install_missing_stockfish: bool,
) -> Tuple[Callable[[], EngineAdapter], str]:
    if engine_name == "mock":
        return MockEngine, "mockfish"
    if engine_name == "stockfish":
        path = _resolve_stockfish_path(stockfish_path, install_missing_stockfish)
        return lambda: StockfishEngine(path), "stockfish"
    raise ValueError("unknown engine: {0}".format(engine_name))


def _resolve_stockfish_path(
    stockfish_path: Optional[str],
    install_missing_stockfish: bool,
) -> str:
    path = stockfish_path or find_stockfish_executable()
    if path is None and install_missing_stockfish:
        path = install_stockfish().executable_path
    if path is None:
        raise FileNotFoundError(
            "Stockfish executable not found. Run `prepforge-chess install-stockfish` "
            "or pass `--stockfish-path`."
        )
    return path


def _print_analysis_progress(progress: AnalysisProgress) -> None:
    if progress.phase == "started":
        print("progress: started 0/{0}".format(progress.total_plies))
    elif progress.phase == "analyzing":
        print(
            "progress: analyzing {0}/{1} {2}".format(
                progress.current_ply,
                progress.total_plies,
                progress.san or "",
            ).rstrip()
        )
    elif progress.phase == "move_complete":
        print(
            "progress: done {0}/{1} {2} {3}".format(
                progress.current_ply,
                progress.total_plies,
                progress.san or "",
                progress.classification.value if progress.classification else "",
            ).rstrip()
        )
    elif progress.phase == "completed":
        print("progress: completed {0}/{1}".format(progress.current_ply, progress.total_plies))


def _format_summary(summary) -> str:
    if not summary:
        return "-"
    return ", ".join("{0}={1}".format(key, summary[key]) for key in sorted(summary))


def run_demo_analysis(args: argparse.Namespace) -> int:
    return run_analysis(
        pgn_text=SMOKE_PGN,
        depth=args.depth,
        engine_name=args.engine,
        stockfish_path=args.stockfish_path,
        install_missing_stockfish=args.install_stockfish,
        show_progress=args.progress,
        workers=args.workers,
    )


def run_pgn_analysis(args: argparse.Namespace) -> int:
    with open(args.path, "r", encoding="utf-8") as file:
        pgn_text = file.read()
    return run_analysis(
        pgn_text=pgn_text,
        depth=args.depth,
        engine_name=args.engine,
        stockfish_path=args.stockfish_path,
        install_missing_stockfish=args.install_stockfish,
        show_progress=args.progress,
        workers=args.workers,
    )


def run_stockfish_install(args: argparse.Namespace) -> int:
    try:
        result = install_stockfish(
            target_dir=Path(args.target_dir) if args.target_dir else None,
            asset_name=args.asset_name,
        )
        print("stockfish: ok")
        print("path: {0}".format(result.executable_path))
        if result.already_present:
            print("status: already_present")
        elif result.asset is not None:
            print("status: installed")
            print("release: {0} ({1})".format(result.asset.release_name, result.asset.release_tag))
            print("asset: {0}".format(result.asset.asset_name))
        return 0
    except Exception as exc:
        print("stockfish: failed")
        print("error: {0}".format(exc))
        return 1


def run_demo_build(args: argparse.Namespace) -> int:
    engine: Optional[EngineAdapter] = None
    try:
        connection = connect_database()
        apply_schema(connection)
        repository = PrepForgeRepository(connection)
        engine = _create_engine(
            engine_name=args.engine,
            stockfish_path=args.stockfish_path,
            install_missing_stockfish=args.install_stockfish,
        )
        service = OpeningBuilderService(
            repository,
            engine=engine,
            engine_config=EngineAnalysisConfig(depth=args.engine_depth),
            maia=create_maia3_adapter(),
        )
        repertoire = service.create_repertoire(
            CreateRepertoireRequest(
                name=args.name,
                color=Color(args.color),
                notes="CLI demo repertoire",
            )
        )
        repertoire, summary = service.generate_from_node(
            repertoire.id,
            repertoire.root_node.id,
            GenerateConfig(
                depth_plies=args.depth,
                max_new_nodes=args.max_nodes,
                own_side_candidate_count=args.own_candidates,
                opponent_branch_threshold=args.opponent_threshold,
                sub_branch_threshold=args.sub_branch_threshold,
            ),
        )
        loaded = repository.load_repertoire(repertoire.id)
        print("build: ok")
        print("repertoire_id: {0}".format(repertoire.id))
        print("name: {0}".format(repertoire.name))
        print("color: {0}".format(repertoire.color.value))
        print("added_nodes: {0}".format(summary.added_nodes))
        print("updated_nodes: {0}".format(summary.updated_nodes))
        print("high_probability_unprepared: {0}".format(summary.high_probability_unprepared))
        if loaded is not None:
            report = service.tree_report(loaded.id, filter_mode=args.filter)
            if args.demo_operations and report.visible_nodes:
                target = next((item for item in report.visible_nodes if item.depth > 0), None)
                if target is not None:
                    service.mark_prepared(loaded.id, target.node_id, True)
                    service.add_tag(loaded.id, target.node_id, "demo")
                    service.add_comment(loaded.id, target.node_id, "Marked by demo operation")
                    service.set_as_mainline(loaded.id, target.node_id)
                    report = service.tree_report(loaded.id, filter_mode=args.filter)
                    print("demo_operations: marked {0}".format(target.node_id))
            print("nodes_total: {0}".format(report.total_nodes))
            print("tree:")
            for line in _render_opening_report(report):
                print(line)
            if args.export or args.export_json or args.export_pgn:
                _print_or_write_repertoire_exports(loaded, args)
        return 0
    except Exception as exc:
        print("build: failed")
        print("error: {0}".format(exc))
        return 1
    finally:
        if isinstance(engine, StockfishEngine):
            engine.close()


def run_demo_train(args: argparse.Namespace) -> int:
    try:
        connection = connect_database()
        apply_schema(connection)
        repository = PrepForgeRepository(connection)
        repertoire = _create_demo_training_repertoire(repository)
        service = TrainingService(repository)
        mode = TrainingMode(args.mode)
        session = service.start_or_resume_session(
            repertoire.id,
            mode=mode,
            seed=args.seed,
        )
        resumed = service.start_or_resume_session(
            repertoire.id,
            mode=mode,
            seed=args.seed + 1,
        )
        lines = service.training_lines(repertoire, mode)
        prompt = service.current_prompt(session.id)
        if prompt is None:
            raise ValueError("demo repertoire produced no training prompt")

        wrong_move = _first_different_legal_move(prompt.fen_before, prompt.expected_move_uci)
        wrong_result = service.submit_move(session.id, wrong_move)
        retry_prompt = wrong_result.next_prompt
        if retry_prompt is None:
            raise ValueError("wrong attempt did not keep a retry prompt")
        correct_result = service.submit_move(session.id, retry_prompt.expected_move_uci)
        resumed_after_attempts = service.start_or_resume_session(repertoire.id, mode=mode)

        print("train: ok")
        print("repertoire_id: {0}".format(repertoire.id))
        print("session_id: {0}".format(session.id))
        print("resume_kept_session: {0}".format(str(resumed.id == session.id).lower()))
        print(
            "resume_after_attempts_index: {0}".format(
                resumed_after_attempts.current_index
            )
        )
        print("seed: {0}".format(session.seed))
        print("mode: {0}".format(mode.value))
        print("line_count: {0}".format(len(lines)))
        for index, line in enumerate(lines, start=1):
            print("line_{0}: {1}".format(index, line.san))
        print("initial_expected: {0} {1}".format(prompt.expected_move_san, prompt.expected_move_uci))
        print(
            "wrong_attempt: played={0} expected={1} mistakes={2}".format(
                wrong_result.played_uci,
                wrong_result.expected_uci,
                len(wrong_result.session.mistakes),
            )
        )
        print(
            "correct_attempt: played={0} completed_line={1} mistakes={2}".format(
                correct_result.played_uci,
                str(correct_result.completed_line).lower(),
                len(correct_result.session.mistakes),
            )
        )
        if correct_result.next_prompt is not None:
            print(
                "next_expected: {0} {1}".format(
                    correct_result.next_prompt.expected_move_san,
                    correct_result.next_prompt.expected_move_uci,
                )
            )
        else:
            print("next_expected: none")
        return 0
    except Exception as exc:
        print("train: failed")
        print("error: {0}".format(exc))
        return 1


def run_ui(args: argparse.Namespace) -> int:
    try:
        run_web_server(
            host=args.host,
            port=args.port,
            db_path=Path(args.db_path),
        )
        return 0
    except KeyboardInterrupt:
        return 0
    except Exception as exc:
        print("ui: failed")
        print("error: {0}".format(exc))
        return 1


def _create_demo_training_repertoire(repository: PrepForgeRepository):
    builder = OpeningBuilderService(repository, engine=MockEngine())
    repertoire = builder.create_repertoire(
        CreateRepertoireRequest(
            name="Trainer Demo",
            color=Color.WHITE,
            notes="CLI demo trainer repertoire",
        )
    )
    e4 = builder.add_move(
        repertoire.id,
        repertoire.root_node.id,
        "e2e4",
        is_mainline=True,
        is_user_prepared_move=True,
        tags=["prepared"],
    )
    e5 = builder.add_move(
        repertoire.id,
        e4.id,
        "e7e5",
        source=MoveSource.GENERATED_MAIA3,
        is_mainline=True,
    )
    builder.add_move(
        repertoire.id,
        e5.id,
        "g1f3",
        is_mainline=True,
        is_user_prepared_move=True,
        tags=["prepared"],
    )
    d4 = builder.add_move(
        repertoire.id,
        repertoire.root_node.id,
        "d2d4",
        is_user_prepared_move=True,
        tags=["prepared", "high-priority"],
    )
    d5 = builder.add_move(
        repertoire.id,
        d4.id,
        "d7d5",
        source=MoveSource.GENERATED_MAIA3,
    )
    builder.add_move(
        repertoire.id,
        d5.id,
        "c2c4",
        is_user_prepared_move=True,
        tags=["prepared"],
    )
    loaded = repository.load_repertoire(repertoire.id)
    if loaded is None:
        raise ValueError("failed to load demo training repertoire")
    return loaded


def _first_different_legal_move(fen: str, expected_uci: str) -> str:
    for move_uci in ChessCore().legal_moves(fen):
        if move_uci != expected_uci:
            return move_uci
    raise ValueError("no alternative legal move available")


def _render_opening_report(report: OpeningTreeReport) -> List[str]:
    lines: List[str] = []
    for item in report.visible_nodes:
        flags = []
        if item.is_mainline:
            flags.append("main")
        if item.is_prepared:
            flags.append("prep")
        if not item.is_enabled:
            flags.append("disabled")
        if item.maia_probability is not None:
            flags.append("p={0:.0f}%".format(item.maia_probability * 100))
        if item.tags:
            flags.append("tags={0}".format(",".join(item.tags)))
        suffix = " [{0}]".format(" ".join(flags)) if flags else ""
        lines.append(
            "  {0}{1} ({2}){3}".format(
                "  " * item.depth,
                item.san,
                item.source.value,
                suffix,
            )
        )
    return lines


def _print_or_write_repertoire_exports(repertoire, args: argparse.Namespace) -> None:
    exporter = RepertoireExportService()
    package = exporter.export_package(repertoire)
    package_json = exporter.export_package_json(repertoire)
    mainline_pgn = exporter.export_mainline_pgn(repertoire)

    print("export_schema: {0}".format(package["schema_version"]))
    print("export_nodes: {0}".format(len(package["nodes"])))
    if args.export_json:
        _write_text(args.export_json, package_json)
        print("export_json: {0}".format(args.export_json))
    if args.export_pgn:
        _write_text(args.export_pgn, mainline_pgn)
        print("export_pgn: {0}".format(args.export_pgn))
    if args.export:
        print("mainline_pgn:")
        print(mainline_pgn)


def _write_text(path: str, text: str) -> None:
    target = Path(path)
    if target.parent and not target.parent.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")


def _add_engine_args(parser: argparse.ArgumentParser, *, include_analysis_controls: bool = True) -> None:
    parser.add_argument(
        "--engine",
        choices=["mock", "stockfish"],
        default="mock",
        help="Engine backend to use.",
    )
    parser.add_argument("--stockfish-path", help="Path to a Stockfish executable.")
    parser.add_argument(
        "--install-stockfish",
        action="store_true",
        help="Download Stockfish automatically if no executable is found.",
    )
    if include_analysis_controls:
        parser.add_argument(
            "--progress",
            action="store_true",
            help="Print per-move analysis progress events.",
        )
        parser.add_argument(
            "--workers",
            type=int,
            default=1,
            help="Number of independent analysis workers. Each Stockfish worker uses its own process.",
        )


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="prepforge-chess")
    subparsers = parser.add_subparsers(dest="command")
    subparsers.add_parser("smoke", help="Run a minimal end-to-end project smoke check.")
    demo_parser = subparsers.add_parser("demo-viewer", help="Render the built-in demo PGN.")
    demo_parser.add_argument("--ply", type=int, default=0, help="Ply to render.")
    demo_parser.add_argument("--flipped", action="store_true", help="Render from Black's side.")
    demo_parser.add_argument(
        "--interactive",
        action="store_true",
        help="Open a small terminal viewer with n/p and arrow-key navigation.",
    )
    pgn_parser = subparsers.add_parser("view-pgn", help="Render a PGN file in the terminal.")
    pgn_parser.add_argument("path", help="Path to a PGN file.")
    pgn_parser.add_argument("--ply", type=int, default=0, help="Ply to render.")
    pgn_parser.add_argument("--flipped", action="store_true", help="Render from Black's side.")
    pgn_parser.add_argument(
        "--interactive",
        action="store_true",
        help="Open a small terminal viewer with n/p and arrow-key navigation.",
    )
    analyze_demo_parser = subparsers.add_parser(
        "analyze-demo",
        help="Run engine analysis on the built-in demo PGN.",
    )
    analyze_demo_parser.add_argument("--depth", type=int, default=10, help="Analysis depth.")
    _add_engine_args(analyze_demo_parser)
    analyze_pgn_parser = subparsers.add_parser(
        "analyze-pgn",
        help="Run engine analysis on a PGN file.",
    )
    analyze_pgn_parser.add_argument("path", help="Path to a PGN file.")
    analyze_pgn_parser.add_argument("--depth", type=int, default=10, help="Analysis depth.")
    _add_engine_args(analyze_pgn_parser)
    install_parser = subparsers.add_parser(
        "install-stockfish",
        help="Download official Stockfish release asset into engines/stockfish.",
    )
    install_parser.add_argument("--target-dir", help="Install directory. Defaults to engines/stockfish.")
    install_parser.add_argument("--asset-name", help="Exact release asset name to download.")
    build_parser = subparsers.add_parser(
        "demo-build",
        help="Create a demo repertoire and generate an opening tree.",
    )
    build_parser.add_argument("--name", default="Demo Repertoire", help="Repertoire name.")
    build_parser.add_argument("--color", choices=["white", "black"], default="white")
    build_parser.add_argument("--depth", type=int, default=4, help="Generation depth in plies.")
    build_parser.add_argument("--engine-depth", type=int, default=8, help="Engine depth for generated moves.")
    build_parser.add_argument("--max-nodes", type=int, default=24, help="Maximum nodes to add.")
    build_parser.add_argument("--own-candidates", type=int, default=1)
    build_parser.add_argument("--opponent-threshold", type=float, default=0.10)
    build_parser.add_argument("--sub-branch-threshold", type=float, default=0.30)
    build_parser.add_argument(
        "--filter",
        choices=["all", "mainline", "prepared", "human-likely", "engine", "mistake-traps"],
        default="all",
        help="Tree report filter.",
    )
    build_parser.add_argument(
        "--demo-operations",
        action="store_true",
        help="Run context-menu style node operations on the first generated child.",
    )
    build_parser.add_argument(
        "--export",
        action="store_true",
        help="Print a PGN preview and export summary for the generated repertoire.",
    )
    build_parser.add_argument(
        "--export-json",
        help="Write a complete repertoire package JSON file.",
    )
    build_parser.add_argument(
        "--export-pgn",
        help="Write the generated mainline as a PGN file.",
    )
    _add_engine_args(build_parser, include_analysis_controls=False)
    train_parser = subparsers.add_parser(
        "demo-train",
        help="Run a saved-session trainer flow on a demo repertoire.",
    )
    train_parser.add_argument(
        "--seed",
        type=int,
        default=13,
        help="Seed used only when the saved session is first created.",
    )
    train_parser.add_argument(
        "--mode",
        choices=[mode.value for mode in TrainingMode],
        default=TrainingMode.ALL_LINES.value,
        help="Training mode for the demo session.",
    )
    ui_parser = subparsers.add_parser(
        "ui",
        help="Run the local PrepForge web UI.",
    )
    ui_parser.add_argument("--host", default="127.0.0.1", help="Host to bind.")
    ui_parser.add_argument("--port", type=int, default=8765, help="Port to bind.")
    ui_parser.add_argument(
        "--db-path",
        default=str(DEFAULT_DB_PATH),
        help="SQLite database path for the local UI.",
    )

    args = parser.parse_args(argv)
    if args.command == "smoke":
        return run_smoke()
    if args.command == "demo-viewer":
        return run_demo_viewer(args)
    if args.command == "view-pgn":
        return run_pgn_viewer(args)
    if args.command == "analyze-demo":
        return run_demo_analysis(args)
    if args.command == "analyze-pgn":
        return run_pgn_analysis(args)
    if args.command == "install-stockfish":
        return run_stockfish_install(args)
    if args.command == "demo-build":
        return run_demo_build(args)
    if args.command == "demo-train":
        return run_demo_train(args)
    if args.command == "ui":
        return run_ui(args)

    parser.print_help()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
