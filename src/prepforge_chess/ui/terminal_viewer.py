from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from typing import Callable, List, Optional

from prepforge_chess.core.chess_core import ChessCore
from prepforge_chess.core.models import Color
from prepforge_chess.services.game_navigation import GameNavigationService, GameNavigationState


@dataclass(frozen=True)
class TerminalRenderOptions:
    flipped: bool = False
    legal_move_sample_size: int = 16
    move_context_radius: int = 4


class TerminalBoardRenderer:
    def __init__(self, chess_core: Optional[ChessCore] = None):
        self.chess_core = chess_core or ChessCore()

    def render(
        self,
        state: GameNavigationState,
        options: TerminalRenderOptions = TerminalRenderOptions(),
    ) -> str:
        lines = [
            "PrepForge Chess",
            "Ply {0}/{1}".format(state.current_ply, state.total_plies),
            "",
        ]
        lines.extend(self._render_board(state, flipped=options.flipped))
        lines.extend(
            [
                "",
                "FEN: {0}".format(state.board_state.fen),
                "Last: {0}".format(state.board_state.last_move_uci or "-"),
                "Current: {0}".format(state.current_move.san if state.current_move else "start"),
                "Next: {0}".format(state.next_move.san if state.next_move else "end"),
                "Status: {0}".format(self._status_text(state)),
                "Legal: {0}".format(
                    self._legal_sample(
                        state.board_state.legal_moves,
                        sample_size=options.legal_move_sample_size,
                    )
                ),
                "",
                "Moves:",
                self._render_move_list(state, context_radius=options.move_context_radius),
                "",
                "Controls: n/right next, p/left previous, number jump, q quit",
            ]
        )
        return "\n".join(lines)

    def _render_board(self, state: GameNavigationState, *, flipped: bool) -> List[str]:
        board = self.chess_core.board(state.board_state.fen)
        files = list("abcdefgh")
        ranks = list(range(8, 0, -1))
        if flipped:
            files = list(reversed(files))
            ranks = list(reversed(ranks))

        lines = ["    {0}".format("  ".join(files))]
        for rank in ranks:
            cells = []
            for file_name in files:
                square = self._square_index(file_name, rank)
                piece = board.piece_at(square)
                cells.append(piece.symbol() if piece else ".")
            lines.append(" {0}  {1}  {0}".format(rank, "  ".join(cells)))
        lines.append("    {0}".format("  ".join(files)))
        return lines

    def _render_move_list(self, state: GameNavigationState, *, context_radius: int) -> str:
        if not state.move_list:
            return "  (no moves)"

        start_ply = max(1, state.current_ply - context_radius)
        end_ply = min(state.total_plies, state.current_ply + context_radius)
        visible = [
            item for item in state.move_list if start_ply <= item.ply <= end_ply
        ]

        tokens: List[str] = []
        for item in visible:
            if item.side_to_move is Color.WHITE:
                tokens.append("{0}.".format(item.move_number))
            san = "[{0}]".format(item.san) if item.ply == state.current_ply else item.san
            tokens.append(san)

        prefix = "... " if start_ply > 1 else ""
        suffix = " ..." if end_ply < state.total_plies else ""
        return "  {0}{1}{2}".format(prefix, " ".join(tokens), suffix)

    def _legal_sample(self, legal_moves: List[str], *, sample_size: int) -> str:
        if not legal_moves:
            return "-"
        sample = legal_moves[:sample_size]
        suffix = " ..." if len(legal_moves) > sample_size else ""
        return "{0}{1}".format(" ".join(sample), suffix)

    def _status_text(self, state: GameNavigationState) -> str:
        if state.status.is_checkmate:
            return "checkmate"
        if state.status.is_stalemate:
            return "stalemate"
        if state.status.is_check:
            return "check"
        if state.status.is_insufficient_material:
            return "insufficient material"
        return "normal"

    def _square_index(self, file_name: str, rank: int) -> int:
        return (rank - 1) * 8 + (ord(file_name) - ord("a"))


class TerminalGameViewer:
    def __init__(
        self,
        navigation: GameNavigationService,
        game_id: str,
        renderer: Optional[TerminalBoardRenderer] = None,
        input_func: Callable[[str], str] = input,
        output_func: Callable[[str], None] = print,
    ):
        self.navigation = navigation
        self.game_id = game_id
        self.renderer = renderer or TerminalBoardRenderer()
        self.input_func = input_func
        self.output_func = output_func

    def run(self, *, initial_ply: int = 0, flipped: bool = False) -> int:
        ply = initial_ply
        while True:
            state = self.navigation.state_for_game_id(self.game_id, ply=ply)
            self._clear_screen()
            self.output_func(
                self.renderer.render(
                    state,
                    TerminalRenderOptions(flipped=flipped),
                )
            )

            command = self._read_command()
            if command == "quit":
                return 0
            if command == "next":
                ply = min(state.total_plies, ply + 1)
            elif command == "previous":
                ply = max(0, ply - 1)
            elif command and command.isdigit():
                ply = min(state.total_plies, max(0, int(command)))

    def _read_command(self) -> str:
        if self.input_func is input and sys.stdin.isatty():
            raw_command = self._read_keypress_command()
            if raw_command:
                return raw_command

        prompt_value = self.input_func("> ").strip().lower()
        if prompt_value in {"q", "quit", "exit"}:
            return "quit"
        if prompt_value in {"n", "next", "right", "\x1b[c"}:
            return "next"
        if prompt_value in {"p", "prev", "previous", "left", "\x1b[d"}:
            return "previous"
        return prompt_value

    def _read_keypress_command(self) -> str:
        self.output_func("Command: n/p, left/right, number+enter, q")
        if os.name == "nt":
            return self._read_windows_keypress()
        return self._read_posix_keypress()

    def _read_windows_keypress(self) -> str:
        try:
            import msvcrt
        except ImportError:
            return ""

        key = msvcrt.getwch()
        if key in {"\x00", "\xe0"}:
            second = msvcrt.getwch()
            if second == "M":
                return "next"
            if second == "K":
                return "previous"
            return ""
        if key.lower() in {"q", "n", "p"}:
            return {"q": "quit", "n": "next", "p": "previous"}[key.lower()]
        if key.isdigit():
            digits = [key]
            while True:
                next_key = msvcrt.getwch()
                if next_key == "\r":
                    return "".join(digits)
                if next_key.isdigit():
                    digits.append(next_key)
        return ""

    def _read_posix_keypress(self) -> str:
        try:
            import termios
            import tty
        except ImportError:
            return ""

        file_descriptor = sys.stdin.fileno()
        old_settings = termios.tcgetattr(file_descriptor)
        try:
            tty.setraw(file_descriptor)
            key = sys.stdin.read(1)
            if key == "\x1b":
                sequence = key + sys.stdin.read(2)
                if sequence == "\x1b[C":
                    return "next"
                if sequence == "\x1b[D":
                    return "previous"
            if key.lower() in {"q", "n", "p"}:
                return {"q": "quit", "n": "next", "p": "previous"}[key.lower()]
            if key.isdigit():
                digits = [key]
                while True:
                    next_key = sys.stdin.read(1)
                    if next_key in {"\r", "\n"}:
                        return "".join(digits)
                    if next_key.isdigit():
                        digits.append(next_key)
        finally:
            termios.tcsetattr(file_descriptor, termios.TCSADRAIN, old_settings)
        return ""

    def _clear_screen(self) -> None:
        if sys.stdout.isatty():
            os.system("cls" if os.name == "nt" else "clear")
