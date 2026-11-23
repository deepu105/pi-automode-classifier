"""Checks the Hermes wrapper in hermes/: what it sends the guard, what it hands back to Hermes, and
what it does when the guard cannot answer. Hermes is not needed: a fake ctx stands in for it, and the
config used here names no model, so no server is needed either. The commands under test are only
named, never run.

Needs a Node that runs TypeScript directly (22.18 or newer).
Usage: python3 test_hermes.py
"""

from __future__ import annotations

import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import types
import unittest
from pathlib import Path
from types import ModuleType
from unittest import mock

REPO = Path(__file__).resolve().parent
# Not under a temp directory: the rules treat those as scratch space.
FIXTURE = Path.home() / "pi-automode-classifier-hermes-py-test"
# The session works in a project folder, not inside the Hermes home: the whole home is what a
# session must not change on its own.
WORKSPACE = Path.home() / "pi-automode-classifier-hermes-py-work"


def load_plugin():
    """Import the plugin folder the way Hermes' loader does: as a package with its submodules.
    Returns the package, the module with the hooks, and the module with the node calls."""
    name = "hermes_plugins__automode_classifier_test"
    spec = importlib.util.spec_from_file_location(name, REPO / "__init__.py", submodule_search_locations=[str(REPO)])
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module, importlib.import_module(f"{name}.hermes.plugin"), importlib.import_module(f"{name}.hermes.node_hook")


class Ctx:
    """The part of Hermes' PluginContext the wrapper uses."""

    def __init__(self, profile_name="tech", session_cwd=""):
        self.profile_name = profile_name
        self.hooks = {}
        self.commands = {}
        self._cwd = session_cwd

    def register_hook(self, name, fn):
        self.hooks.setdefault(name, []).append(fn)

    def register_command(self, name, handler=None, description="", args_hint=""):
        self.commands[name] = handler

    def session_cwd(self):
        return self._cwd

    def guard(self, tool, args="ls", session_id="s1", **kwargs):
        return self.hooks["pre_tool_call"][0](tool_name=tool, args=args, session_id=session_id, **kwargs)

    def turn(self, history=None, message="do it", session_id="s1", platform="cli"):
        return self.hooks["pre_llm_call"][0](session_id=session_id, user_message=message, conversation_history=history or [], platform=platform)

    def status(self, args="", session_id="s1"):
        return self.commands["automode-classifier"](args, session_id=session_id)


class Wrapper(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod, cls.plugin, cls.nh = load_plugin()

    def setUp(self):
        shutil.rmtree(FIXTURE, ignore_errors=True)
        shutil.rmtree(WORKSPACE, ignore_errors=True)
        self.nh.SESSIONS._by_session.clear()  # one store is shared by the whole run: no test sees another's session
        (FIXTURE / "automode-classifier").mkdir(parents=True)
        WORKSPACE.mkdir()
        self.workspace = WORKSPACE
        self.config = FIXTURE / "automode-classifier" / "config.json"
        self.write_config({"decider": []})
        self.env = patch_env({"HERMES_HOME": str(FIXTURE), "HERMES_INTERACTIVE": "1", "HERMES_EXEC_ASK": "", "HERMES_CRON_SESSION": "", "HERMES_KANBAN_TASK": "", "HERMES_PLATFORM": ""})
        self.env.__enter__()
        self.ctx = Ctx(session_cwd=str(self.workspace))
        self.mod.register(self.ctx)
        self.ctx.turn()

    def tearDown(self):
        self.env.__exit__(None, None, None)
        shutil.rmtree(FIXTURE, ignore_errors=True)
        shutil.rmtree(WORKSPACE, ignore_errors=True)

    def write_config(self, obj):
        self.config.write_text(json.dumps(obj))

    # register()
    def test_registers_the_hooks_and_the_command(self):
        self.assertEqual(sorted(self.ctx.hooks), ["on_session_start", "post_tool_call", "pre_llm_call", "pre_tool_call"])
        self.assertEqual(list(self.ctx.commands), ["automode-classifier"])

    # what the guard answers
    def test_a_plain_command_runs(self):
        self.assertIsNone(self.ctx.guard("terminal", {"command": "ls"}))

    def test_an_unmapped_tool_runs(self):
        self.assertIsNone(self.ctx.guard("browser", {"url": "http://example.com"}))

    def test_arguments_that_are_not_a_dict_go_to_the_gate(self):
        """Nothing to read the call from is not the same as a call found safe."""
        answer = self.ctx.guard("terminal", "ls -la")
        self.assertEqual(answer["action"], "approve")
        self.assertIn("could not read", answer["message"])

    def test_a_denied_command_is_blocked_with_a_reason(self):
        answer = self.ctx.guard("terminal", {"command": "rm -rf /"})
        self.assertEqual(answer["action"], "block")
        self.assertTrue(answer["message"])

    def test_an_ask_becomes_an_approval_with_a_rule_key(self):
        answer = self.ctx.guard("terminal", {"command": "git push origin main"})
        self.assertEqual(answer["action"], "approve")
        self.assertTrue(answer["rule_key"].startswith("automode:terminal:"))

    def test_a_write_outside_the_session_asks(self):
        answer = self.ctx.guard("write_file", {"path": str(FIXTURE / "elsewhere.txt"), "content": "x"})
        self.assertEqual(answer["action"], "approve")

    def test_a_workdir_of_its_own_does_not_move_the_session(self):
        """`terminal` takes a `workdir` the model sets: it is a `cd` inside the command, not the
        project, so a write beside it is still a write outside the session."""
        elsewhere = FIXTURE / "elsewhere"
        elsewhere.mkdir()
        self.assertEqual(self.ctx.guard("terminal", {"command": "echo hi > evil.txt", "workdir": str(elsewhere)})["action"], "approve")
        request, _ = self.plugin._request("s1", tool="terminal", args={"command": "ls", "workdir": str(elsewhere)})
        self.assertEqual(request["cwd"], str(self.workspace))

    def test_a_write_to_the_guard_own_config_asks(self):
        answer = self.ctx.guard("write_file", {"path": str(self.config), "content": "x"})
        self.assertEqual(answer["action"], "approve")

    def test_a_session_turned_off_runs_everything_it_may(self):
        self.ctx.status("off")
        self.assertIsNone(self.ctx.guard("terminal", {"command": "git push origin main"}))
        self.ctx.status("on")
        self.assertEqual(self.ctx.guard("terminal", {"command": "git push origin main"})["action"], "approve")

    def test_the_answer_is_logged(self):
        self.ctx.guard("terminal", {"command": "git push origin main"})
        lines = [json.loads(l) for l in (FIXTURE / "automode-classifier" / "decisions.jsonl").read_text().splitlines()]
        self.assertIn("git push origin main", [e["subject"] for e in lines])

    # who can answer
    def test_without_anyone_to_answer_an_ask_is_a_block(self):
        with patch_env({"HERMES_INTERACTIVE": "", "HERMES_EXEC_ASK": ""}):
            self.assertIsNone(self.ctx.guard("terminal", {"command": "ls"}))
            self.assertEqual(self.ctx.guard("terminal", {"command": "git push origin main"})["action"], "block")

    def test_approval_possible_follows_the_session(self):
        possible = self.plugin.approval_possible
        with patch_env({"HERMES_INTERACTIVE": "1"}):
            self.assertTrue(possible("cli"))
        with patch_env({"HERMES_INTERACTIVE": "", "HERMES_EXEC_ASK": "1", "HERMES_CRON_SESSION": "", "HERMES_KANBAN_TASK": ""}):
            self.assertTrue(possible("telegram"))
            self.assertFalse(possible("webhook"))
            # No platform named: Hermes set the exec ask, so an approval can be shown.
            self.assertTrue(possible(""))
        with patch_env({"HERMES_INTERACTIVE": "1", "HERMES_CRON_SESSION": "1"}):
            self.assertFalse(possible("cli"))
        with patch_env({"HERMES_INTERACTIVE": "1", "HERMES_KANBAN_TASK": "task-7"}):
            self.assertFalse(possible("cli"))
        # `hermes chat -q` exports HERMES_INTERACTIVE so sudo works, and nobody is waiting.
        with patch_env({"HERMES_INTERACTIVE": "1", "HERMES_SINGLE_QUERY_SESSION": "1"}):
            self.assertFalse(possible("cli"))

    def test_a_single_query_run_of_hermes_own_check_is_not_interactive(self):
        """Hermes knows a -q run has nobody to answer, and says so itself; the plugin asks it."""
        fake = ModuleType("tools.approval_context")
        fake._is_single_query_approval_context = lambda: True
        with mock.patch.dict(sys.modules, {"tools": ModuleType("tools"), "tools.approval_context": fake}):
            with patch_env({"HERMES_INTERACTIVE": "1", "HERMES_SINGLE_QUERY_SESSION": ""}):
                self.assertFalse(self.plugin.approval_possible("cli"))

    # the session text
    def test_the_turn_message_is_kept_when_history_lacks_it(self):
        self.ctx.turn(history=[{"role": "user", "content": "earlier"}], message="now this")
        kept = self.nh.SESSIONS.take("s1")["history"]
        self.assertEqual([m["content"] for m in kept], ["earlier", "now this"])

    def test_the_turn_message_is_not_doubled_when_history_has_it(self):
        self.ctx.turn(history=[{"role": "user", "content": "now this"}], message="now this")
        self.assertEqual(len(self.nh.SESSIONS.take("s1")["history"]), 1)

    def test_a_multimodal_turn_keeps_its_text(self):
        self.ctx.turn(message=[{"type": "text", "text": "look at this"}, {"type": "image_url", "url": "x"}])
        self.assertEqual(self.nh.SESSIONS.take("s1")["history"][-1]["content"], "look at this")

    def test_a_finished_call_is_added_for_the_next_one(self):
        self.ctx.hooks["post_tool_call"][0](tool_name="terminal", args={"command": "ls"}, result='"file"', session_id="s1", duration_ms=3)
        kept = self.nh.SESSIONS.take("s1")["history"]
        self.assertEqual([m["role"] for m in kept], ["user", "assistant", "tool"])
        self.assertEqual(kept[1]["tool_calls"][0]["function"]["name"], "terminal")

    def test_the_session_store_stays_bounded(self):
        store = self.nh.Sessions()
        store._one("a")
        for i in range(self.nh.MAX_SESSIONS + 5):
            store._one(f"s{i}")
        self.assertLessEqual(len(store._by_session), self.nh.MAX_SESSIONS)
        self.assertNotIn("a", store._by_session)
        big = [{"role": "user", "content": str(i)} for i in range(self.nh.MAX_HISTORY + 50)]
        store.start_turn("big", big)
        self.assertEqual(len(store.take("big")["history"]), self.nh.MAX_HISTORY)


    def test_the_node_of_the_hermes_install_is_found_for_a_profile(self):
        """A profile run has no node of its own: Hermes keeps it in the install home."""
        node = FIXTURE / ".hermes" / "tools" / "node-26.1.0-linux-x64" / "bin"
        node.mkdir(parents=True)
        stub = node / "node"
        stub.write_text('#!/bin/sh\necho v26.1.0\n')
        stub.chmod(0o755)
        with patch_env({"HOME": str(FIXTURE), "HERMES_HOME": str(FIXTURE / ".hermes" / "profiles" / "tech"), "PATH": "/nonexistent"}):
            self.nh._NODE = None
            try:
                found = self.nh.node_binary()
            finally:
                self.nh._NODE = None
        self.assertEqual(found, str(stub))

    # which config applies
    def test_the_profile_home_holds_the_config(self):
        (FIXTURE / "profiles" / "tech" / "automode-classifier").mkdir(parents=True)
        (FIXTURE / "profiles" / "tech" / "automode-classifier" / "config.json").write_text(json.dumps({"decider": [], "withoutUi": {"onAsk": "allow"}}))
        with patch_env({"HERMES_SESSION_PROFILE": "tech"}):
            request, _ = self.plugin._request("s1", tool="terminal", args={"command": "ls"})
        self.assertEqual(request["config"], str(FIXTURE / "profiles" / "tech" / "automode-classifier" / "config.json"))

    def test_a_run_that_points_at_its_own_home_uses_it(self):
        with patch_env({"HERMES_HOME": str(FIXTURE / "profiles" / "tech")}):
            self.assertEqual(self.plugin._profile_home(), FIXTURE / "profiles" / "tech")

    def test_the_request_names_the_paths_the_guard_locks(self):
        request, _ = self.plugin._request("s1", tool="terminal", args={"command": "ls"})
        locked = request["guarded"]
        self.assertIn(str(REPO), locked)
        for name in ("config.yaml", ".env", "SOUL.md", "shell-hooks-allowlist.json"):
            self.assertIn(str(FIXTURE / name), locked)
        self.assertEqual(request["ownDirs"], [str(FIXTURE)])
        self.assertEqual(
            request["paths"],
            {"skills": str(FIXTURE / "skills"), "memories": str(FIXTURE / "memories"), "scripts": str(FIXTURE / "scripts")},
        )

    def test_every_profile_of_the_install_is_locked(self):
        """One profile must not switch the guard off in another one."""
        (FIXTURE / "profiles" / "generic" / "automode-classifier").mkdir(parents=True)
        request, _ = self.plugin._request("s1", tool="terminal", args={"command": "ls"})
        self.assertIn(str(FIXTURE / "profiles" / "generic" / "automode-classifier"), request["guarded"])
        self.assertIn(str(FIXTURE / "profiles" / "generic" / "config.yaml"), request["guarded"])

    def test_a_write_to_another_profiles_guard_config_is_locked(self):
        other = FIXTURE / "profiles" / "generic" / "automode-classifier"
        other.mkdir(parents=True)
        (other / "config.json").write_text("{}")
        answer = self.ctx.guard("write_file", {"path": str(other / "config.json"), "content": '{"enabled": false}'})
        self.assertEqual(answer["action"], "approve")
        self.assertIn("guard's own files", answer["message"], answer["message"])

    def test_a_note_and_a_script_of_this_home_are_the_products_own_files(self):
        """`memory` and a cron script name no folder the rules saw; the home is what they change."""
        for name in ("memories/MEMORY.md", "scripts/nightly.sh", "skills/notes/SKILL.md"):
            answer = self.ctx.guard("write_file", {"path": str(FIXTURE / name), "content": "x"})
            self.assertEqual(answer["action"], "approve", name)
            self.assertIn("Hermes's own files", answer["message"], name)

    def test_a_skill_change_is_judged_as_a_change_in_the_skills_folder(self):
        """`skill_manage` names a skill, not a path: the folder it writes in is what gets judged."""
        answer = self.ctx.guard("skill_manage", {"operations": [{"action": "create", "name": "notes", "content": "x"}]})
        self.assertIsNotNone(answer, "a skill change is not left undecided")
        self.assertEqual(answer["action"], "approve")

    def test_the_request_names_the_session_and_its_state_folder(self):
        request, _ = self.plugin._request("s-9", tool="terminal", args={"command": "ls"})
        self.assertEqual(request["session"], "s-9")
        self.assertEqual(request["sessions"], str(FIXTURE / "automode-classifier" / "sessions"))

    def test_what_one_call_learns_is_there_for_the_next(self):
        """Two calls are two node processes: what the first one downloaded is what the second judges."""
        self.write_config({"decider": [], "rules": {"allow": ["curl *"]}})
        downloaded = self.workspace / "downloaded.sh"
        downloaded.write_text("#!/bin/sh\necho hi\n")
        self.assertIsNone(self.ctx.guard("terminal", {"command": f"curl -o {downloaded} http://example.com/x.sh"}))
        answer = self.ctx.guard("terminal", {"command": "./downloaded.sh"})
        self.assertEqual(answer["action"], "approve")
        self.assertIn("downloaded in this session", answer["message"])
        self.assertTrue((FIXTURE / "automode-classifier" / "sessions" / "s1.json").is_file())

    def test_the_key_of_an_endpoint_comes_from_the_environment(self):
        self.write_config({"providers": {"pc": {"baseUrl": "http://x/v1", "apiKeyEnv": "AMC_TEST_KEY"}}})
        with patch_env({"AMC_TEST_KEY": " abc "}):
            raw = self.nh.raw_config(self.config)
            self.assertEqual(self.nh.resolve_providers(raw), {"pc": {"baseUrl": "http://x/v1", "apiKey": "abc"}})

    def test_a_secret_the_environment_lacks_comes_from_hermes(self):
        """A profile keeps its keys in the Hermes vault, which a plugin reads through agent.secret_scope."""
        scope = types.ModuleType("agent.secret_scope")
        scope.get_secret = lambda name: "from-vault" if name == "AMC_TEST_KEY" else None
        agent = types.ModuleType("agent")
        agent.secret_scope = scope
        saved = {k: sys.modules.get(k) for k in ("agent", "agent.secret_scope")}
        sys.modules["agent"], sys.modules["agent.secret_scope"] = agent, scope
        try:
            self.assertEqual(self.nh._secret("AMC_TEST_KEY"), "from-vault")
            with patch_env({"AMC_TEST_KEY": "from-env"}):
                self.assertEqual(self.nh._secret("AMC_TEST_KEY"), "from-env")
        finally:
            for k, v in saved.items():
                if v is None:
                    del sys.modules[k]
                else:
                    sys.modules[k] = v

    def test_a_config_that_is_not_readable_is_no_error_for_python(self):
        self.config.write_text("{ not json")
        request, budget = self.plugin._request("s1", tool="terminal", args={"command": "ls"})
        self.assertEqual(request["mode"], "decide")
        self.assertGreater(budget, 60)

    # how long to wait, and what happens when the wait fails
    def test_the_wait_covers_both_chat_passes_and_the_scorer(self):
        self.write_config({"llm": {"timeoutMs": 45000, "twoStage": True}, "classifier": {"timeoutMs": 15000}, "command": {"timeoutMs": 5000}})
        budget = self.nh.budget_s(self.nh.raw_config(self.config))
        self.assertEqual(budget, 45 + 45 + 15 + 5 + self.nh.SLACK_S)
        self.write_config({"llm": {"timeoutMs": 45000, "twoStage": False}})
        self.assertEqual(self.nh.budget_s(self.nh.raw_config(self.config)), 45 + 5 + 5 + self.nh.SLACK_S)

    def test_a_guard_that_cannot_be_started_asks_for_approval(self):
        self.nh._NODE = str(FIXTURE / "no-such-node")
        try:
            answer = self.ctx.guard("terminal", {"command": "git push origin main"})
        finally:
            self.nh._NODE = None
        self.assertEqual(answer["action"], "approve")
        self.assertIn("could not decide", answer["message"])

    def test_a_guard_that_answers_nonsense_asks_for_approval(self):
        real = self.nh.run_guard
        self.nh.run_guard = lambda request, timeout_s: {"action": "ship"}
        try:
            answer = self.ctx.guard("terminal", {"command": "git push origin main"})
        finally:
            self.nh.run_guard = real
        self.assertEqual(answer["action"], "approve")

    def test_a_guard_that_is_late_gets_one_sigterm(self):
        """A node child this side gave up on is asked to stop, not killed: a kill can cut a state
        file between the write and the rename."""
        script = FIXTURE / "late-guard.js"
        script.write_text(
            'const fs = require("fs");\n'
            'process.on("SIGTERM", () => { fs.writeFileSync(process.env.STOP_LOG, "term"); process.exit(0); });\n'
            "setTimeout(() => {}, 60000);\n"
        )
        stopped = FIXTURE / "stopped"
        real = self.nh.guard_path
        self.nh.guard_path = lambda: script
        with patch_env({"STOP_LOG": str(stopped)}):
            try:
                with self.assertRaises(RuntimeError):
                    self.nh.run_guard({"mode": "decide"}, 0.5)
            finally:
                self.nh.guard_path = real
        self.assertTrue(stopped.exists(), "the child was killed instead of asked to stop")

    def test_a_status_that_fails_says_so(self):
        real = self.nh.run_guard
        self.nh.run_guard = lambda request, timeout_s: (_ for _ in ()).throw(RuntimeError("node is gone"))
        try:
            self.assertIn("node is gone", self.ctx.status())
        finally:
            self.nh.run_guard = real

    # the slash command
    def test_status_shows_the_config(self):
        self.write_config({"decider": ["classifier"], "classifier": {"provider": "pc", "model": "lancet"}, "providers": {"pc": {"baseUrl": "http://x/v1", "apiKeyEnv": "K"}}})
        text = self.ctx.status()
        self.assertIn("Auto mode: on", text)
        self.assertIn("pc/lancet, via Hermes", text)
        self.assertIn("1. Rules:", text)

    def test_on_and_off_report_themselves(self):
        self.assertEqual(self.ctx.status("off"), "Auto mode is off for this session.")
        self.assertEqual(self.ctx.status("on"), "Auto mode is on for this session.")

    def test_the_node_found_is_one_that_runs_typescript(self):
        node = self.nh.node_binary()
        self.assertTrue(os.access(node, os.X_OK))
        self.assertTrue(self.nh._new_enough(node))
        self.assertEqual(self.nh.node_binary(), node, "the node found should be kept, not looked up again")

    # warming the chat decider's prefix cache
    def test_warming_fires_once_per_session(self):
        self.write_config({"decider": ["llm"], "llm": {"warmCache": True, "provider": "pc", "model": "m"}})
        warmed = []
        with mock.patch.object(self.nh, "spawn_warm", lambda request: warmed.append(request["session"])):
            for _ in range(3):
                self.plugin._warm_cache(session_id="w1")
            self.plugin._warm_cache(session_id="w2")
        self.assertEqual(warmed, ["w1", "w2"])
        self.assertTrue((FIXTURE / "automode-classifier" / "sessions" / "w1.warm").is_file())

    def test_a_turn_warms_once_too(self):
        """Hermes may fire only the turn hook: it warms, and only the first turn claims it."""
        self.write_config({"decider": ["llm"], "llm": {"warmCache": True, "provider": "pc", "model": "m"}})
        warmed = []
        with mock.patch.object(self.nh, "spawn_warm", lambda request: warmed.append(request["session"])):
            self.ctx.turn(session_id="w3")
            self.ctx.turn(session_id="w3")
        self.assertEqual(warmed, ["w3"])

    def test_warming_waits_for_nothing(self):
        """The turn must not wait for the warm call: the wrapper starts a process and leaves it."""
        started = []

        class NoWait:
            """A child that fails the test if anything waits for it or reads from it."""

            def __init__(self, *args, **kwargs):
                started.append(kwargs.get("stdout"))
                self.stdin = io.StringIO()

            def wait(self, *a, **k):
                raise AssertionError("spawn_warm must not wait for the process it started")

            def communicate(self, *a, **k):
                raise AssertionError("spawn_warm must not read from the process it started")

        # node_binary is stood in for: it starts a process of its own to check the version, and
        # the fake Popen below would answer it.
        with mock.patch.object(self.nh, "node_binary", lambda: "/bin/true"), mock.patch.object(self.nh.subprocess, "Popen", NoWait):
            self.nh.spawn_warm({"mode": "warm"})
        self.assertEqual(started, [subprocess.DEVNULL], "the child's output goes to nothing, not to a pipe we hold")

    def test_warming_only_when_the_config_asks_for_it(self):
        warmed = []
        spawn = lambda request: warmed.append(request["session"])  # noqa: E731
        cases = [
            ("the decider has no chat model", {"decider": ["classifier"], "llm": {"warmCache": True}}),
            ("warming is off", {"decider": ["llm"], "llm": {}}),
            ("auto mode is off", {"decider": ["llm"], "enabled": False, "llm": {"warmCache": True}}),
        ]
        for i, (_, config) in enumerate(cases):
            self.write_config(config)
            with mock.patch.object(self.nh, "spawn_warm", spawn):
                self.plugin._warm_cache(session_id=f"off-{i}")
        self.assertEqual(warmed, [])

    def test_a_session_turned_off_does_not_warm(self):
        self.write_config({"decider": ["llm"], "llm": {"warmCache": True}})
        self.ctx.status("off")
        warmed = []
        with mock.patch.object(self.nh, "spawn_warm", lambda request: warmed.append(request["session"])):
            self.plugin._warm_cache(session_id="s1")
        self.assertEqual(warmed, [])


class patch_env:
    """Set environment variables for a block, then put them back."""

    def __init__(self, values):
        self.values = values

    def __enter__(self):
        self.old = {k: os.environ.get(k) for k in self.values}
        os.environ.update(self.values)
        return self

    def __exit__(self, *exc):
        for key, value in self.old.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


if __name__ == "__main__":
    unittest.main(verbosity=2)
