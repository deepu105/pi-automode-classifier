"""The hooks Hermes calls, for auto mode.

``pre_tool_call`` asks the guard about one call and passes the answer on as a Hermes directive: a
block, or an escalation to the approval gate. ``pre_llm_call`` and ``post_tool_call`` only keep the
session text the guard reads. Everything here fails closed: a guard that cannot answer sends the
call to the approval gate, and the gate denies what nobody answers.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from . import node_hook
from .node_hook import SESSIONS

log = logging.getLogger(__name__)

# The platforms nobody sits in front of. An approval raised there has nobody to answer it.
PROGRAMMATIC = {"api_server", "webhook", "msgraph_webhook", "cron"}

_PLUGIN_DIR = Path(__file__).resolve().parent.parent
_CTX = None


def _truthy(value) -> bool:
    return str(value or "").strip().lower() in ("1", "true", "yes", "on")


def register(ctx) -> None:
    global _CTX
    _CTX = ctx
    ctx.register_hook("pre_tool_call", _guard_tool_call)
    ctx.register_hook("pre_llm_call", _start_turn)
    ctx.register_hook("post_tool_call", _end_call)
    ctx.register_hook("on_session_start", _warm_cache)
    ctx.register_command(
        "automode-classifier",
        handler=_command,
        description="Auto mode: show what decides a call, or turn it on or off for this session.",
        args_hint="[status|on|off]",
    )


def _session_env(name: str) -> str:
    """One value from the session that fired the hook, the way Hermes reads its own session values."""
    try:
        from gateway.session_context import get_session_env  # public: the running session's platform, profile, cwd

        return str(get_session_env(name, "") or "")
    except Exception:
        return os.environ.get(name, "")


def _profile_home() -> Path:
    """The Hermes home whose config applies to this call.

    A profile CLI run points HERMES_HOME at its own home already. One gateway process serves every
    profile and binds the profile per turn, so there the profile says which home to read.
    """
    base = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")
    profile = _session_env("HERMES_SESSION_PROFILE") or (_CTX.profile_name if _CTX else "")
    if profile and profile != "default" and base.name != profile:
        candidate = base / "profiles" / profile
        if candidate.is_dir():
            return candidate
    return base


def _paths(home: Path) -> tuple[list[str], list[str]]:
    """Locked paths, and the paths that name this product. See core/guard.ts."""
    automode = home / "automode-classifier"
    locked = [
        str(_PLUGIN_DIR),
        str(automode),
        str(home / "config.yaml"),
        str(home / ".env"),
        str(home / "SOUL.md"),
        str(home / "shell-hooks-allowlist.json"),
    ]
    return locked, [str(home / "plugins")]


def approval_possible(platform: str) -> bool:
    """True when a person could answer an approval for this session.

    Follows how Hermes resolves an approval: an interactive CLI, or a gateway chat that is not a
    programmatic platform. Cron and kanban runs have nobody to answer. Hermes denies an approval no
    one answers, so a session like this gets the config's `withoutUi` answer instead.
    """
    # A cron run sets a flag; a kanban worker names the task it works on. Neither has a person.
    if _truthy(os.environ.get("HERMES_CRON_SESSION")) or os.environ.get("HERMES_KANBAN_TASK"):
        return False
    if _truthy(os.environ.get("HERMES_INTERACTIVE")):
        return True
    where = (platform or _session_env("HERMES_SESSION_PLATFORM") or os.environ.get("HERMES_PLATFORM") or "").strip().lower()
    if where in PROGRAMMATIC:
        return False
    return _truthy(os.environ.get("HERMES_EXEC_ASK"))


def _cwd(args: dict) -> str:
    """Where the call runs: the call's own directory, then the session's, then this process's."""
    for value in (args.get("workdir"), _CTX.session_cwd() if _CTX else "", _session_env("HERMES_SESSION_CWD"), os.getcwd()):
        if isinstance(value, str) and value and os.path.isdir(value):
            return value
    return os.getcwd()


def _request(session_id: str, mode: str = "decide", tool: str = "", args: dict | None = None, tool_call_id: str = "") -> tuple[dict, float]:
    """The JSON the guard needs, and how long to wait for it."""
    home = _profile_home()
    config_file = home / "automode-classifier" / "config.json"
    raw = node_hook.raw_config(config_file)
    session = SESSIONS.take(session_id)
    guarded, own = _paths(home)
    request = {
        "mode": mode,
        "config": str(config_file),
        "example": str(_PLUGIN_DIR / "config.example.jsonc"),
        "log": str((home / "automode-classifier" / "decisions.jsonl")),
        "guarded": guarded,
        "ownDirs": own,
        "hasUI": approval_possible(session.get("platform", "")),
        "history": session.get("history", []),
        "providers": node_hook.resolve_providers(raw),
        # The session, and where its state file lives: what it wrote and downloaded, its counts and
        # its denials come back from here. See core/session.ts.
        "session": session_id,
        "sessions": str(home / "automode-classifier" / "sessions"),
        "tool": tool,
        "input": args or {},
        "cwd": _cwd(args or {}),
        "toolCallId": tool_call_id,
    }
    if session.get("enabled") is not None:
        request["enabled"] = session["enabled"]
    return request, node_hook.budget_s(raw)


def _guard_tool_call(tool_name: str, args: dict, task_id: str = "", session_id: str = "", tool_call_id: str = "", **kwargs):
    """Ask the guard about one call, before it runs."""
    if not isinstance(args, dict):
        return None  # nothing to read the call from; Hermes deals with it
    session_id = session_id or task_id
    try:
        request, budget = _request(session_id, tool=tool_name, args=args, tool_call_id=tool_call_id)
        answer = node_hook.run_guard(request, budget)
    except Exception as e:  # includes a late guard, a missing node, and an unreadable answer
        log.warning("automode-classifier: %s", e)
        return {"action": "approve", "message": f"auto mode could not decide about this call ({e}); approve only if you know it is safe", "rule_key": f"automode:{tool_name}:guard-failed"}
    action = answer.get("action")
    if action == "block":
        return {"action": "block", "message": answer.get("message") or "blocked by auto mode"}
    if action == "approve":
        return {"action": "approve", "message": answer.get("message") or "auto mode needs your approval", "rule_key": answer.get("rule_key") or ""}
    if action == "allow":
        return None
    return {"action": "approve", "message": f"the guard answered {action}, which this wrapper does not know; approve only if you know this call is safe", "rule_key": f"automode:{tool_name}:guard-failed"}


def _text_of(message) -> str:
    """The plain text of a message, which for a multimodal turn is the text of its parts."""
    if isinstance(message, str):
        return message
    if isinstance(message, list):
        return " ".join(str(part.get("text", "")) for part in message if isinstance(part, dict) and part.get("type") == "text").strip()
    return ""


def _warming_useful(raw: dict, session_id: str) -> bool:
    """The same check Pi makes at session start: a chat decider in use, turned on, and warming asked for."""
    if raw.get("enabled") is False or "llm" not in (raw.get("decider") or []):
        return False
    if not (raw.get("llm") or {}).get("warmCache"):
        return False
    return SESSIONS.take(session_id).get("enabled") is not False


def _warm_cache(session_id: str = "", **kwargs) -> None:
    """One throwaway chat call per session, so the first decision does not pay a cold prefill.

    Hermes has two hooks that can start it: ``on_session_start`` on the first turn of a new session,
    and ``pre_llm_call`` on every turn. Whichever comes first claims the session's marker; the others
    do nothing. The call runs in its own process and this one does not wait for it.
    """
    try:
        home = _profile_home()
        raw = node_hook.raw_config(home / "automode-classifier" / "config.json")
        if not _warming_useful(raw, session_id):
            return
        if not node_hook.claim_warm(home / "automode-classifier" / "sessions", session_id):
            return
        request, _ = _request(session_id, mode="warm")
        node_hook.spawn_warm(request)
    except Exception as e:  # a warm call is a bonus: nothing here may disturb the turn
        log.debug("automode-classifier: warming skipped (%s)", e)
    return None


def _start_turn(session_id: str = "", user_message="", conversation_history=None, platform: str = "", **kwargs) -> None:
    """Keep the session text from the turn's start. The return is not used: this only watches."""
    history = list(conversation_history or [])
    # The decider needs what the user asked for. The history is a copy taken before the turn's own
    # message was added, so add it when it is missing.
    text = _text_of(user_message)
    last = history[-1] if history else {}
    if text and not (last.get("role") == "user" and _text_of(last.get("content")) == text):
        history.append({"role": "user", "content": text})
    SESSIONS.start_turn(session_id, history, platform)
    _warm_cache(session_id=session_id)
    return None


def _end_call(tool_name: str, args: dict, result: str, task_id: str = "", session_id: str = "", **kwargs) -> None:
    """Add one finished call to the session text, so the next call in the turn can see it."""
    SESSIONS.add_call(session_id or task_id, tool_name, args if isinstance(args, dict) else {}, result)
    return None


def _command(raw_args: str = "", *, session_id: str = "") -> str:
    """/automode-classifier: the status of this session, or its on/off choice."""
    choice = (raw_args or "").strip().lower()
    if choice in ("on", "off"):
        SESSIONS.set_enabled(session_id, choice == "on")
        return f"Auto mode is {choice} for this session."
    try:
        request, budget = _request(session_id, mode="status")
        answer = node_hook.run_guard(request, budget)
    except Exception as e:
        return f"Auto mode status failed: {e}"
    return answer.get("text") or "Auto mode gave no status."
