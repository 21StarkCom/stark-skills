#!/usr/bin/env python3
"""Statusline segment configurator — TUI and CLI for Claude Code statusline.

Usage:
    python3 config/statusline-setup.py              # Interactive TUI
    python3 config/statusline-setup.py --list        # Show segment states
    python3 config/statusline-setup.py --enable model,cost
    python3 config/statusline-setup.py --disable vim_mode,end_time
    python3 config/statusline-setup.py --install     # Install to ~/.claude/
    python3 config/statusline-setup.py --reset       # Reset all to enabled
"""
from __future__ import annotations

import argparse
import curses
import json
import sys
from pathlib import Path

# ── Paths ────────────────────────────────────────────────────────────────

SCRIPT_DIR = Path(__file__).resolve().parent
STATUSLINE_SH = SCRIPT_DIR / "statusline-command.sh"
CLAUDE_DIR = Path.home() / ".claude"
INSTALLED_SH = CLAUDE_DIR / "statusline-command.sh"
INSTALLED_SETTINGS = CLAUDE_DIR / "settings.json"
SEGMENTS_JSON = CLAUDE_DIR / "statusline-segments.json"

# ── Segment registry ────────────────────────────────────────────────────
# (id, label, line, description, preview_text)

SEGMENTS = [
    ("repo_name",     "Repo Name",       1, "Git remote repository name",     "\U0001f5c2\ufe0f stark-skills"),
    ("wt_name",       "Worktree",        1, "Worktree directory name",        "\U0001f332 feature-x"),
    ("git_branch",    "Git Branch",      1, "Current branch name",            "\u2618\ufe0f main"),
    ("git_dirty",     "Dirty State",     1, "Changed/untracked counts + diff", "\U0001f4c4 3 +12 -4"),
    ("model",         "Model",           1, "Claude model display name",      "Opus 1M"),
    ("inflight",      "Inflight Count",  1, "In-flight tool calls",           "\u26a1\ufe0f 2"),
    ("longest_tool",  "Longest Tool",    1, "Longest running tool + time",    "\u23f3 Read 3m"),
    ("last_tool",     "Last Tool",       1, "Most recent tool + elapsed",     "\u23f1\ufe0f Grep 200ms"),
    ("q_pending",     "Queue Pending",   1, "Pending telemetry items (>5)",   "\U0001fab2 12"),
    ("q_dead",        "Dead Letters",    1, "Dead letter queue count",        "\U0001f41e 3"),
    ("session_name",  "Session Name",    1, "Named session identifier",       "refactor-auth"),
    ("vim_mode",      "Vim Mode",        1, "Vim N/I mode indicator",         "N"),
    ("api_ratio",     "API Ratio",       1, "API vs wall time %",            "\u2699\ufe0f 72%"),
    ("ctx_usage",     "Context Usage",   2, "Context window % used",          "\U0001f9e0 45%"),
    ("tokens",        "Token Flow (per turn)", 2, "Last API call: fresh \u2192 cache-read (hit%) \u2192 output", "\u2b06 5.3k \u2192 \U0001f4d6 178k 97% \u2192 \u2b07 850"),
    ("cost",          "Session Cost",    2, "Real cost (cost.total_cost_usd) + per-hour burn rate", "\U0001f4b0 $1.234 \u00b7 $4.94/h"),
    ("cost_rate",     "Burn Rate",       2, "Append per-hour rate to cost segment (sub-toggle)",   "$4.94/h"),
    ("session_dur",   "Session Duration",2, "Total elapsed session time",     "\U0001faab 12m"),
    ("five_hour_rl",  "5h Rate Limit",   2, "5-hour rate limit % + reset",    "\U0001f6dd 32% \u23f3 3h12m"),
    ("weekly_rl",     "Weekly Limit",    2, "7-day rate limit % + reset",     "\U0001f4c5 18% \U0001f570\ufe0f 4d2h"),
    ("tier_warn",     "1M-tier Warning", 2, "Flag when exceeds_200k_tokens (Opus 2x pricing)", "\u26a0\ufe0f 1M-tier"),
    ("tokens_total",  "Tokens (cumulative)", 2, "Session-wide totals (off by default; re-counts cached input each turn)", "\u03a3\u2b06 5.8M \u03a3\u2b07 12k"),
    ("code_churn",    "Code Churn",      2, "Lines added/removed",            "\u270f\ufe0f +42 -17"),
]

VALID_IDS = {s[0] for s in SEGMENTS}

# ── Config I/O ──────────────────────────────────────────────────────────


def load_config() -> dict[str, bool]:
    states = {s[0]: True for s in SEGMENTS}
    if SEGMENTS_JSON.exists():
        try:
            states.update(json.loads(SEGMENTS_JSON.read_text()))
        except (json.JSONDecodeError, OSError):
            pass
    return states


def save_config(states: dict[str, bool]) -> None:
    CLAUDE_DIR.mkdir(parents=True, exist_ok=True)
    SEGMENTS_JSON.write_text(json.dumps(states, indent=2) + "\n")


# ── Install ─────────────────────────────────────────────────────────────


def install_statusline() -> list[str]:
    """Ensure statusline is installed. Returns actions taken."""
    actions: list[str] = []
    CLAUDE_DIR.mkdir(parents=True, exist_ok=True)

    # 1. Script symlink
    if INSTALLED_SH.is_symlink() and INSTALLED_SH.resolve() == STATUSLINE_SH.resolve():
        actions.append("Script symlink OK")
    else:
        if INSTALLED_SH.exists() or INSTALLED_SH.is_symlink():
            INSTALLED_SH.unlink()
        INSTALLED_SH.symlink_to(STATUSLINE_SH)
        actions.append(f"Linked {INSTALLED_SH.name} -> {STATUSLINE_SH}")

    # 2. Patch settings.json
    entry = {"type": "command", "command": f"bash {INSTALLED_SH}"}
    settings: dict = {}
    if INSTALLED_SETTINGS.exists():
        try:
            settings = json.loads(INSTALLED_SETTINGS.read_text())
        except (json.JSONDecodeError, OSError):
            pass

    if settings.get("statusLine") == entry:
        actions.append("settings.json OK")
    else:
        settings["statusLine"] = entry
        tmp = INSTALLED_SETTINGS.with_suffix(".tmp")
        tmp.write_text(json.dumps(settings, indent=2) + "\n")
        tmp.rename(INSTALLED_SETTINGS)
        actions.append("Patched settings.json")

    return actions


# ── Preview ─────────────────────────────────────────────────────────────


def build_preview(states: dict[str, bool]) -> tuple[str, str]:
    sep = " | "
    l1 = sep.join(s[4] for s in SEGMENTS if s[2] == 1 and states.get(s[0], True))
    l2 = sep.join(s[4] for s in SEGMENTS if s[2] == 2 and states.get(s[0], True))
    return l1, l2


# ── Curses TUI ──────────────────────────────────────────────────────────


def _safe_addstr(win: curses.window, y: int, x: int, text: str,
                 attr: int = 0, *, maxw: int | None = None) -> None:
    """addstr that silently clips to window bounds."""
    h, w = win.getmaxyx()
    if y < 0 or y >= h or x >= w:
        return
    avail = w - x - 1
    if maxw is not None:
        avail = min(avail, maxw)
    if avail <= 0:
        return
    try:
        win.addnstr(y, x, text, avail, attr)
    except curses.error:
        pass


def run_tui(states: dict[str, bool]) -> dict[str, bool] | None:
    try:
        return curses.wrapper(_tui_main, dict(states))
    except curses.error as e:
        print(f"Terminal error: {e}. Use --list / --enable / --disable instead.", file=sys.stderr)
        sys.exit(1)


def _tui_main(stdscr: curses.window, st: dict[str, bool]) -> dict[str, bool] | None:
    curses.curs_set(0)
    curses.use_default_colors()

    curses.init_pair(1, curses.COLOR_WHITE, -1)
    curses.init_pair(2, curses.COLOR_BLACK, curses.COLOR_WHITE)   # selected
    curses.init_pair(3, curses.COLOR_GREEN, -1)                   # enabled
    curses.init_pair(4, curses.COLOR_RED, -1)                     # disabled
    curses.init_pair(5, curses.COLOR_CYAN, -1)                    # header
    curses.init_pair(6, curses.COLOR_YELLOW, -1)                  # preview
    curses.init_pair(7, curses.COLOR_MAGENTA, -1)                 # title

    C_NORMAL = curses.color_pair(1)
    C_SELECT = curses.color_pair(2)
    C_ON = curses.color_pair(3)
    C_OFF = curses.color_pair(4)
    C_HEAD = curses.color_pair(5) | curses.A_BOLD
    C_PREV = curses.color_pair(6)
    C_TITLE = curses.color_pair(7) | curses.A_BOLD

    # Build display items: (display_text, seg_id_or_None)
    items: list[tuple[str, str | None]] = []
    items.append(("\u2500\u2500 Line 1: repo \u00b7 branch \u00b7 model \u00b7 operational ", None))
    for sid, label, line, desc, _ in SEGMENTS:
        if line == 1:
            items.append((f"{label:<18} {desc}", sid))
    items.append(("\u2500\u2500 Line 2: gauges \u00b7 tokens \u00b7 cost ", None))
    for sid, label, line, desc, _ in SEGMENTS:
        if line == 2:
            items.append((f"{label:<18} {desc}", sid))

    selectable = [i for i, (_, sid) in enumerate(items) if sid is not None]
    cursor_idx = 0  # index into selectable[]
    scroll = 0

    def _move(delta: int) -> None:
        nonlocal cursor_idx
        cursor_idx = (cursor_idx + delta) % len(selectable)

    while True:
        stdscr.erase()
        h, w = stdscr.getmaxyx()
        if h < 8 or w < 40:
            _safe_addstr(stdscr, 0, 0, "Terminal too small (need 40x8+)", C_OFF)
            stdscr.refresh()
            key = stdscr.getch()
            if key in (ord('q'), 27):
                return None
            continue

        cursor = selectable[cursor_idx]
        enabled_n = sum(1 for v in st.values() if v)

        # ── Title ───────────────────────────────────────────────────
        title = f" Statusline Configurator  [{enabled_n}/{len(SEGMENTS)} on] "
        _safe_addstr(stdscr, 0, 0, title.center(w), C_TITLE)

        # ── Layout ──────────────────────────────────────────────────
        preview_h = 4
        keys_h = 1
        list_h = h - 1 - preview_h - keys_h  # title=1
        if list_h < 5:
            preview_h = 0
            list_h = h - 1 - keys_h

        # Scroll to keep cursor visible
        if cursor < scroll:
            scroll = cursor
        if cursor >= scroll + list_h:
            scroll = cursor - list_h + 1

        # ── Item list ───────────────────────────────────────────────
        for row_i in range(list_h):
            idx = scroll + row_i
            if idx >= len(items):
                break
            y = 1 + row_i
            text, sid = items[idx]
            is_cur = idx == cursor

            if sid is None:
                _safe_addstr(stdscr, y, 1, text, C_HEAD)
            else:
                on = st.get(sid, True)
                check = "[x]" if on else "[ ]"

                if is_cur:
                    _safe_addstr(stdscr, y, 0, " " * (w - 1), C_SELECT)
                    _safe_addstr(stdscr, y, 2, check, C_SELECT | curses.A_BOLD)
                    _safe_addstr(stdscr, y, 6, text, C_SELECT)
                else:
                    chk_attr = C_ON if on else C_OFF
                    txt_attr = C_NORMAL if on else curses.A_DIM
                    _safe_addstr(stdscr, y, 2, check, chk_attr)
                    _safe_addstr(stdscr, y, 6, text, txt_attr)

        # ── Scroll indicator ────────────────────────────────────────
        if len(items) > list_h:
            if scroll > 0:
                _safe_addstr(stdscr, 1, w - 2, "\u25b2", curses.A_DIM)
            if scroll + list_h < len(items):
                _safe_addstr(stdscr, list_h, w - 2, "\u25bc", curses.A_DIM)

        # ── Preview ─────────────────────────────────────────────────
        if preview_h > 0:
            py = h - preview_h - keys_h
            _safe_addstr(stdscr, py, 1, "Preview:", C_HEAD)
            l1, l2 = build_preview(st)
            _safe_addstr(stdscr, py + 1, 2, f"L1: {l1}", C_PREV)
            _safe_addstr(stdscr, py + 2, 2, f"L2: {l2}", C_PREV)

        # ── Key help ────────────────────────────────────────────────
        keys = " [j/k \u2191\u2193]Nav  [Space]Toggle  [a]All on  [n]All off  [Enter]Save+Install  [q]Quit "
        _safe_addstr(stdscr, h - 1, 0, keys.center(w), curses.A_DIM)

        stdscr.refresh()

        # ── Input ───────────────────────────────────────────────────
        key = stdscr.getch()

        if key in (ord('q'), 27):
            return None

        elif key in (curses.KEY_UP, ord('k')):
            _move(-1)

        elif key in (curses.KEY_DOWN, ord('j')):
            _move(1)

        elif key == ord(' '):
            sid = items[cursor][1]
            if sid:
                st[sid] = not st.get(sid, True)

        elif key == ord('a'):
            for sid, *_ in SEGMENTS:
                st[sid] = True

        elif key == ord('n'):
            for sid, *_ in SEGMENTS:
                st[sid] = False

        elif key in (ord('\n'), curses.KEY_ENTER, 10, 13):
            save_config(st)
            actions = install_statusline()

            # Show confirmation
            stdscr.erase()
            msgs = [
                f"Saved {enabled_n}/{len(SEGMENTS)} segments to {SEGMENTS_JSON.name}",
                "",
            ] + [f"  {a}" for a in actions] + [
                "",
                "Restart Claude Code to apply changes.",
                "",
                "Press any key to exit...",
            ]
            for i, line in enumerate(msgs):
                _safe_addstr(stdscr, h // 2 - len(msgs) // 2 + i, 3, line,
                             C_ON | curses.A_BOLD if i == 0 else C_NORMAL)
            stdscr.refresh()
            stdscr.getch()
            return st

        elif key == curses.KEY_RESIZE:
            pass  # loop redraws


# ── CLI commands ─────────────────────────────────────────────────────────


def cmd_list(states: dict[str, bool]) -> None:
    cur_line = 0
    for sid, label, line, desc, _ in SEGMENTS:
        if line != cur_line:
            cur_line = line
            print(f"\n  Line {line}")
            print(f"  {'ID':<16} {'Label':<18} {'State':>5}  Description")
            print(f"  {'\u2500'*16} {'\u2500'*18} {'\u2500'*5}  {'\u2500'*30}")
        on = states.get(sid, True)
        mark = "\033[32m  on\033[0m" if on else "\033[31m off\033[0m"
        print(f"  {sid:<16} {label:<18} {mark}  {desc}")
    print()


def cmd_toggle(states: dict[str, bool], ids_str: str, enable: bool) -> None:
    for sid in ids_str.split(","):
        sid = sid.strip()
        if sid not in VALID_IDS:
            print(f"Unknown segment: {sid}", file=sys.stderr)
            print(f"Valid IDs: {', '.join(sorted(VALID_IDS))}", file=sys.stderr)
            sys.exit(1)
        states[sid] = enable
    save_config(states)
    verb = "Enabled" if enable else "Disabled"
    print(f"{verb}: {ids_str}")


# ── Main ─────────────────────────────────────────────────────────────────


def main() -> None:
    p = argparse.ArgumentParser(
        description="Configure Claude Code statusline segments",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Run without arguments for interactive TUI.",
    )
    p.add_argument("--list", action="store_true", help="List segments and states")
    p.add_argument("--enable", metavar="IDS", help="Enable segments (comma-separated)")
    p.add_argument("--disable", metavar="IDS", help="Disable segments (comma-separated)")
    p.add_argument("--install", action="store_true", help="Install statusline to ~/.claude/")
    p.add_argument("--reset", action="store_true", help="Reset all segments to enabled")
    args = p.parse_args()

    states = load_config()

    if args.list:
        cmd_list(states)
    elif args.reset:
        save_config({s[0]: True for s in SEGMENTS})
        print("All segments reset to enabled.")
    elif args.enable:
        cmd_toggle(states, args.enable, True)
    elif args.disable:
        cmd_toggle(states, args.disable, False)
    elif args.install:
        for a in install_statusline():
            print(f"  {a}")
    else:
        result = run_tui(states)
        if result is None:
            print("Cancelled.")
        else:
            n = sum(1 for v in result.values() if v)
            print(f"Saved: {n}/{len(SEGMENTS)} segments enabled.")


if __name__ == "__main__":
    main()
