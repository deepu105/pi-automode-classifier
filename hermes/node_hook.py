"""Run the guard and remember what it needs about each session.

The guard is the TypeScript under ``hermes/hook.ts``. Hermes runs Python, so each decision goes
through one short-lived node process: a JSON request in, a JSON answer out. This file finds node,
starts it, and keeps the session text and the ``on``/``off`` choice per session, because a new
process per call would remember nothing between calls.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from collections import OrderedDict
from pathlib import Path

# What one call may take: the scorer plus both chat passes, plus time to start node. Pass it to
# ``hermes config set plugins.hook_callback_timeout`` as seconds plus a little more. Hermes ends a
# ``pre_tool_call`` callback at that limit and blocks the tool, so this stays below it: an approval
# beats a timeout block.
SLACK_S = 15.0
DEFAULT_TIMEOUT_S = 120.0  # used only when the config's own timeouts cannot be read
# Message and session caps for the text kept below: long sessions are clipped by the config anyway.
MAX_HISTORY = 300
MAX_SESSIONS = 64


_NODE: str | None = None


def node_binary() -> str:
    """A node that runs TypeScript directly: 22.18 or newer. A node on PATH wins; else Hermes' own.

    Hermes keeps its node under ``tools/node-<version>/bin`` in the home that downloaded it. A node
    too old to strip types is refused with a clear message. The answer is kept: every tool call
    would else pay for a ``node --version`` run.
    """
    global _NODE
    if _NODE:
        return _NODE
    _NODE = _find_node()
    return _NODE


def _find_node() -> str:
    for candidate in _node_candidates():
        if _new_enough(candidate):
            return candidate
    raise RuntimeError("auto mode needs Node 22.18 or newer (it runs a .ts file directly); none found")


def _node_candidates() -> "list[str]":
    """Every node worth trying: the one on PATH, then Hermes' own, newest folder first.

    A profile run sets HERMES_HOME to the profile home, and Hermes keeps its node in the install
    home (``~/.hermes/tools``), not in the profile home. So both are searched, and a profile home
    reaches past itself to the home that holds its tool downloads.
    """
    out: "list[str]" = []
    on_path = shutil.which("node")
    if on_path:
        out.append(on_path)
    homes = []
    env_home = os.environ.get("HERMES_HOME")
    if env_home:
        homes.append(Path(env_home).expanduser())
    install = Path.home() / ".hermes"
    homes.append(install)
    for home in list(homes):
        if home.parent.name == "profiles":  # <home>/profiles/<name>: its tools are two levels up
            homes.append(home.parent.parent)
    for tools in dict.fromkeys(home / "tools" for home in homes):
        folders = sorted((d for d in tools.glob("node-*") if (d / "bin" / "node").is_file()), key=_version_key, reverse=True)
        out.extend(str(d / "bin" / "node") for d in folders)
    return list(dict.fromkeys(out))


def _version_key(path: Path) -> tuple:
    # node-22.18.0 sorts as a number, not as a word: "node-9" is older than "node-22".
    return tuple(int(part) if part.isdigit() else 0 for part in path.name.removeprefix("node-").split(".")[:3])


def _new_enough(binary: str) -> bool:
    try:
        out = subprocess.run([binary, "--version"], capture_output=True, text=True, timeout=10).stdout
        parts = out.strip().lstrip("v").split(".")
        return (int(parts[0]), int(parts[1])) >= (22, 18)
    except Exception:
        return False


def guard_path() -> Path:
    return Path(__file__).resolve().parent / "hook.ts"


def budget_s(config: dict) -> float:
    """Seconds to wait for one guard run, from the config's own stage timeouts."""
    try:
        stage3 = float(config.get("llm", {}).get("timeoutMs", 60000)) / 1000
        if config.get("llm", {}).get("twoStage", True):
            stage3 *= 2
        stage2 = float(config.get("classifier", {}).get("timeoutMs", 5000)) / 1000
        stage2 += float(config.get("command", {}).get("timeoutMs", 5000)) / 1000
        return stage3 + stage2 + SLACK_S
    except Exception:
        return DEFAULT_TIMEOUT_S


def run_guard(request: dict, timeout_s: float) -> dict:
    """One guard run. Raises when node is missing, late, or answers with something unreadable."""
    argv = [node_binary(), "--disable-warning=ExperimentalWarning", str(guard_path())]
    proc = subprocess.run(
        argv,
        input=json.dumps(request),
        capture_output=True,
        text=True,
        timeout=timeout_s,
    )
    line = next((l for l in reversed(proc.stdout.splitlines()) if l.strip()), "")
    if not line:
        raise RuntimeError(f"the guard printed nothing (exit {proc.returncode}): {proc.stderr.strip()[:300]}")
    answer = json.loads(line)
    if not isinstance(answer, dict) or answer.get("action") not in ("allow", "approve", "block", "status"):
        raise RuntimeError(f"the guard answered {line[:200]}")
    return answer


class Sessions:
    """Per session: the messages so far, the platform, and whether auto mode is on for it.

    Hermes hands a hook the whole message list at the start of a turn and nothing after that, so the
    calls made inside a turn are added here from ``post_tool_call``. Bounded: the oldest session and
    the oldest messages go first.
    """

    def __init__(self) -> None:
        self._by_session: "OrderedDict[str, dict]" = OrderedDict()

    def _one(self, session_id: str) -> dict:
        if session_id not in self._by_session:
            self._by_session[session_id] = {"history": [], "platform": "", "enabled": None}
            while len(self._by_session) > MAX_SESSIONS:
                self._by_session.popitem(last=False)
        self._by_session[session_id]["session_id"] = session_id
        self._by_session.move_to_end(session_id)
        return self._by_session[session_id]

    def start_turn(self, session_id: str, history: list, platform: str = "") -> None:
        one = self._one(session_id)
        one["history"] = list(history or [])[-MAX_HISTORY:]
        if platform:
            one["platform"] = platform

    def add_call(self, session_id: str, tool: str, args: dict, result: str) -> None:
        """Append one finished call, in the message form Hermes uses: a call, then its result."""
        one = self._one(session_id)
        history = one["history"]
        call_id = f"call_{len(history)}"
        history.append({"role": "assistant", "content": "", "tool_calls": [{"id": call_id, "type": "function", "function": {"name": tool, "arguments": json.dumps(args, default=str)[:8000]}}]})
        history.append({"role": "tool", "tool_call_id": call_id, "name": tool, "content": str(result)[:4000]})
        one["history"] = history[-MAX_HISTORY:]

    def take(self, session_id: str) -> dict:
        return dict(self._one(session_id))

    def set_enabled(self, session_id: str, value: "bool | None") -> None:
        self._one(session_id)["enabled"] = value


SESSIONS = Sessions()


def raw_config(path: Path) -> dict:
    """The config as JSON, or {} when it is missing or unreadable. The guard reports the real error.

    Only the keys here are read in Python: the timeouts for the wait, the provider names to resolve
    keys for, and nothing else. The guard reads the file itself and owns every other decision.
    """
    try:
        text = path.read_text()
    except OSError:
        return {}
    try:
        return json.loads(text)
    except ValueError:
        return {}


def resolve_providers(config: dict) -> dict:
    """Each named endpoint in ``providers``, with its key read the way Hermes reads a secret."""
    out = {}
    for name, entry in (config.get("providers") or {}).items():
        if not isinstance(entry, dict):
            continue
        key = _secret(str(entry.get("apiKeyEnv", "")))
        out[name] = {"baseUrl": str(entry.get("baseUrl", "")), "apiKey": key}
    return out


def _secret(name: str) -> str:
    if not name:
        return ""
    value = os.environ.get(name)
    if value:
        return value.strip()
    try:
        from agent.secret_scope import get_secret  # Hermes' own key lookup: the profile vault, then the environment.

        return str(get_secret(name) or "").strip()
    except Exception:
        return ""
