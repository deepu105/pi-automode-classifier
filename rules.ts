// Deterministic rules for pi-automode-classifier. They run before the model and settle
// most tool calls:
//   deny     - blocked outright (wipes of /, $HOME or a system directory, disk formatting)
//   ask      - needs a confirm prompt (root, remote or outward-facing actions, deletes and
//              writes outside the working directory, edits to this guard's own files)
//   allow    - read-only commands, builds and tests, file changes inside the working directory
//   classify - everything else goes to the decision model
//
// A compound command gets the most severe verdict of its parts. Command substitutions and
// `sh -c` strings are parsed as commands too. Syntax the parser does not model (unbalanced
// quotes) is never allowed by rule.
//
// User rules (UserRules) replace the built-in verdict of a simple command. Two things they
// cannot replace: a built-in deny, and the ask for changes to the guard's own files.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Action = "allow" | "classify" | "ask" | "deny";
export interface Verdict {
  action: Action;
  reason: string;
  // A user allow rule cannot replace this verdict.
  locked?: boolean;
}

const HOME = os.homedir();
const RANK: Record<Action, number> = { allow: 0, classify: 1, ask: 2, deny: 3 };
const worst = (...verdicts: Verdict[]): Verdict =>
  verdicts.reduce((a, b) => (RANK[b.action] > RANK[a.action] || (RANK[b.action] === RANK[a.action] && b.locked && !a.locked) ? b : a));
const ALLOW: Verdict = { action: "allow", reason: "" };
const classify = (reason: string): Verdict => ({ action: "classify", reason });
const ask = (reason: string): Verdict => ({ action: "ask", reason });
const deny = (reason: string): Verdict => ({ action: "deny", reason });
const guardAsk = (reason: string): Verdict => ({ action: "ask", reason, locked: true });

// ---- paths ----

// realpath that also works for a path that does not exist: resolves the deepest existing
// ancestor and keeps the rest.
function realish(p: string): string {
  const tail: string[] = [];
  let cur = p;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...tail);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

function within(p: string, dir: string, strict = false): boolean {
  const rel = path.relative(dir, p);
  if (rel === "") return !strict;
  return rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
}

const TMP_DIRS = [...new Set(["/tmp", "/var/tmp", os.tmpdir()].map(realish))];
const DEV_SINKS = /^\/dev\/(null|zero|stdout|stderr|tty|fd\/\d+)$/;

export interface Scope {
  // Working directory, or undefined once a `cd` made it unknown.
  cwd: string | undefined;
  // Project root: file changes inside it are allowed. Undefined when Pi runs from $HOME or above.
  root: string | undefined;
  // This guard's own files and Pi's settings. Changes to them always ask.
  guarded: string[];
  // Extra directories where file changes are allowed, like the project root.
  allowed: string[];
  rules?: UserRules;
}

const expandHome = (p: string) => (p === "~" || p.startsWith("~/") ? HOME + p.slice(1) : p);
const withTargets = (paths: string[]) => [...new Set(paths.map(expandHome).flatMap((p) => [p, realish(p)]))];

export function makeScope(cwd: string, guarded: string[], options: { allowedPaths?: string[]; rules?: UserRules } = {}): Scope {
  const real = realish(cwd);
  return {
    cwd: real,
    root: within(HOME, real) ? undefined : real,
    guarded: withTargets(guarded),
    allowed: withTargets(options.allowedPaths ?? []),
    rules: options.rules,
  };
}

// ---- user rules ----

export interface Matcher {
  source: string;
  test(text: string): boolean;
}
export type UserRules = Record<Action, Matcher[]>;

// A pattern is a glob over one whole simple command, where `*` matches any text and a
// trailing ` *` also matches no arguments. With a `re:` prefix it is a regular expression.
export function compilePattern(pattern: string): Matcher {
  let re: RegExp;
  if (pattern.startsWith("re:")) re = new RegExp(pattern.slice(3), "s");
  else {
    const words = pattern.trim().split(/\s+/).join(" ");
    const open = words.endsWith(" *");
    const body = (open ? words.slice(0, -2) : words).split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
    re = new RegExp(`^${body}${open ? "( .*)?" : ""}$`, "s");
  }
  return { source: pattern, test: (text) => re.test(text) };
}

export function compileRules(rules: Partial<Record<Action, string[]>>): UserRules {
  const compile = (action: Action) => (rules[action] ?? []).map(compilePattern);
  return { deny: compile("deny"), ask: compile("ask"), classify: compile("classify"), allow: compile("allow") };
}

// deny, ask and classify rules also match the command without its wrappers (`timeout 60`,
// `FOO=1`). An allow rule must match the command exactly as written.
function userVerdict(argv: string[], rules: UserRules): Verdict | undefined {
  const raw = argv.join(" ");
  const bare = unwrap(argv).join(" ");
  for (const action of ["deny", "ask", "classify"] as const) {
    const hit = rules[action].find((m) => m.test(raw) || m.test(bare));
    if (hit) return { action, reason: `your ${action} rule "${hit.source}"` };
  }
  return rules.allow.some((m) => m.test(raw)) ? ALLOW : undefined;
}

// Absolute path for a shell word, or undefined when it cannot be known (variable, ~user,
// relative path after an unknown cd).
function resolveWord(word: string, scope: Scope): string | undefined {
  if (/[$`]/.test(word)) return undefined;
  if (word === "~" || word.startsWith("~/")) word = HOME + word.slice(1);
  else if (word.startsWith("~")) return undefined;
  if (!path.isAbsolute(word)) {
    if (!scope.cwd) return undefined;
    word = path.resolve(scope.cwd, word);
  }
  return realish(path.normalize(word));
}

const isGuarded = (p: string | undefined, scope: Scope) => !!p && scope.guarded.some((g) => within(p, g));
const inTmp = (p: string) => TMP_DIRS.some((d) => within(p, d, true));
// Provably inside the project or a temp directory.
const isLocal = (p: string | undefined, scope: Scope) =>
  !!p && ((!!scope.root && within(p, scope.root)) || inTmp(p) || scope.allowed.some((d) => within(p, d)));
// /, a top-level directory, $HOME or a parent of it.
const isRootLike = (p: string) => p === "/" || path.dirname(p) === "/" || within(HOME, p);
const BARE_GLOB = /^(\*|\.\*|\.\[!\.\]\*|\{.*\})$/;

// ---- parser ----

export interface Simple {
  argv: string[];
  // Output redirect targets.
  out: string[];
  // Reads a heredoc: for a shell or interpreter the body is code.
  heredoc?: boolean;
}
export interface Parsed {
  cmds: Simple[];
  // Syntax that is not modelled: never allow by rule.
  opaque: boolean;
  // Subshells or substitutions: `cd` tracking is unreliable.
  grouped: boolean;
}

function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

export function parse(command: string, depth = 0): Parsed {
  const result: Parsed = { cmds: [], opaque: depth > 4, grouped: false };
  if (result.opaque) return result;
  const s = command;
  let cur: Simple = { argv: [], out: [] };
  let word = "";
  let hasWord = false;
  let redirect: "" | "out" | "in" = "";
  // Delimiters of heredocs opened on the current line. Their bodies are data and are skipped.
  const heredocs: string[] = [];

  const pushWord = () => {
    if (hasWord) {
      const expanded = word.replace(/\$\{HOME\}|\$HOME\b/g, HOME);
      if (redirect === "out") cur.out.push(expanded);
      else if (redirect === "") cur.argv.push(expanded);
      redirect = "";
    }
    word = "";
    hasWord = false;
  };
  const pushCmd = () => {
    pushWord();
    redirect = "";
    if (cur.argv.length || cur.out.length) result.cmds.push(cur);
    cur = { argv: [], out: [] };
  };
  // Parses a substitution body as extra commands and leaves a placeholder in the word.
  const nested = (inner: string) => {
    const sub = parse(inner, depth + 1);
    result.cmds.push(...sub.cmds);
    result.opaque ||= sub.opaque;
    result.grouped = true;
    word += "$()";
    hasWord = true;
  };

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const next = s[i + 1];
    if (c === "\\") {
      if (next !== "\n") {
        word += next ?? "";
        hasWord = true;
      }
      i++;
    } else if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) return { ...result, opaque: true };
      word += s.slice(i + 1, end);
      hasWord = true;
      i = end;
    } else if (c === '"') {
      hasWord = true;
      let j = i + 1;
      for (; j < s.length && s[j] !== '"'; j++) {
        if (s[j] === "\\" && j + 1 < s.length) word += s[++j];
        else if (s[j] === "$" && s[j + 1] === "(") {
          const end = matchParen(s, j + 1);
          if (end < 0) return { ...result, opaque: true };
          nested(s.slice(j + 2, end));
          j = end;
        } else if (s[j] === "`") {
          const end = s.indexOf("`", j + 1);
          if (end < 0) return { ...result, opaque: true };
          nested(s.slice(j + 1, end));
          j = end;
        } else word += s[j];
      }
      if (j >= s.length) return { ...result, opaque: true };
      i = j;
    } else if (c === "`") {
      const end = s.indexOf("`", i + 1);
      if (end < 0) return { ...result, opaque: true };
      nested(s.slice(i + 1, end));
      i = end;
    } else if ((c === "$" || c === "<" || c === ">") && next === "(") {
      const end = matchParen(s, i + 1);
      if (end < 0) return { ...result, opaque: true };
      nested(s.slice(i + 2, end));
      i = end;
    } else if (c === "<") {
      pushWord();
      const heredoc = next === "<" && s[i + 2] !== "<" ? /^<<-?\s*(['"]?)([\w.-]+)\1/.exec(s.slice(i)) : null;
      if (heredoc) {
        heredocs.push(heredoc[2]);
        cur.heredoc = true;
        i += heredoc[0].length - 1;
      } else {
        // An input file or here-string is data: skip the word that follows.
        if (next === "<") i += s[i + 2] === "<" ? 2 : 1;
        redirect = "in";
      }
    } else if (c === ">" || (c === "&" && next === ">")) {
      // A number right before `>` is a file descriptor, not an argument.
      if (hasWord && /^\d+$/.test(word)) {
        word = "";
        hasWord = false;
      }
      pushWord();
      if (c === "&") i++;
      if (s[i + 1] === ">" || s[i + 1] === "|") i++;
      if (s[i + 1] === "&") {
        // fd duplication such as 2>&1 has no file target.
        i++;
        while (/[\d-]/.test(s[i + 1] ?? "")) i++;
      } else redirect = "out";
    } else if (c === " " || c === "\t") {
      pushWord();
    } else if (c === "\n" || c === ";") {
      pushCmd();
      while (c === "\n" && heredocs.length) {
        const end = new RegExp(`^\\s*${heredocs.shift()!.replace(/[.\-]/g, "\\$&")}\\s*$`, "m").exec(s.slice(i + 1));
        i = end ? i + end.index + end[0].length : s.length;
      }
    } else if (c === "&" || c === "|") {
      if (next === c || (c === "|" && next === "&")) i++;
      pushCmd();
    } else if (c === "(" || c === ")") {
      result.grouped = true;
      pushCmd();
    } else if (c === "#" && !hasWord) {
      const end = s.indexOf("\n", i);
      i = end < 0 ? s.length : end - 1;
    } else {
      word += c;
      hasWord = true;
    }
  }
  pushCmd();
  return result;
}

// ---- command tables ----

const READ_ONLY = new Set(
  `ls cat bat head tail less more wc rg grep egrep fgrep fd tree stat file du df pwd echo printf
   which whereis type whoami id groups date cal uname hostname uptime printenv ps pgrep free nproc
   lscpu lsblk lsusb lspci lsmod findmnt readlink realpath basename dirname sort uniq cut tr jq yq
   column diff cmp comm nl tac rev fold paste join seq true false test [ sleep export unset wait
   sha256sum sha1sum md5sum b3sum xxd hexdump od strings nm ldd man tldr tokei cloc fastfetch
   journalctl dmesg ss dig nslookup ping getent locale zcat xzcat bzcat zstdcat`.split(/\s+/),
);

// Build, test, lint and format tools that work on the project.
const DEV_TOOLS = new Set(
  `make just ninja cmake ctest meson pytest tox nox ruff mypy pyright black isort flake8 eslint
   prettier tsc vitest jest mocha rustfmt rustc gcc g++ cc c++ clang clang++ shellcheck shfmt
   stylua luacheck biome golangci-lint hadolint yamllint markdownlint ccache`.split(/\s+/),
);

// Per-tool subcommands. Anything not listed goes to the model.
const SUBCOMMANDS: Record<string, { allow: string; ask?: Record<string, string> }> = {
  git: {
    allow: `status diff log show rev-parse rev-list ls-files ls-tree ls-remote blame describe shortlog
      grep cat-file merge-base name-rev show-ref symbolic-ref count-objects check-ignore
      add commit switch fetch pull merge rebase cherry-pick revert mv init clone apply am bisect
      submodule worktree sparse-checkout notes range-diff format-patch whatchanged version help`,
    ask: {
      push: "git push is visible to others",
      "filter-branch": "rewrites git history",
      "filter-repo": "rewrites git history",
    },
  },
  gh: { allow: `search status version help`, ask: {} },
  cargo: {
    allow: `build check test clippy fmt run bench doc tree metadata nextest clean add remove update
      fetch vendor expand audit deny outdated machete version help`,
    ask: { publish: "cargo publish is visible to others", yank: "cargo yank is visible to others", login: "stores a registry token" },
  },
  go: { allow: `build test vet run fmt mod generate list get env version doc tool`, ask: {} },
  uv: { allow: `sync lock add remove pip venv tree export version help`, ask: { publish: "uv publish is visible to others" } },
  pip: { allow: `install list show freeze check download wheel uninstall help`, ask: {} },
  pip3: { allow: `install list show freeze check download wheel uninstall help`, ask: {} },
  docker: {
    allow: `build ps images logs inspect version info history top stats diff port`,
    ask: { push: "docker push is visible to others", login: "stores registry credentials" },
  },
  systemctl: {
    allow: `status show cat list-units list-unit-files list-timers list-sockets list-dependencies
      is-active is-enabled is-failed get-default help`,
    ask: {},
  },
  loginctl: { allow: `list-sessions list-users list-seats show-session show-user session-status user-status`, ask: {} },
  niri: { allow: `validate`, ask: {} },
};
for (const pm of ["npm", "pnpm", "yarn", "bun"]) {
  SUBCOMMANDS[pm] = {
    allow: `test t run run-script ci install i ls list outdated audit why explain build start lint add
      remove rm uninstall update up dedupe prune view info pack link rebuild version help`,
    ask: { publish: `${pm} publish is visible to others`, login: "stores a registry token", adduser: "stores a registry token", unpublish: "visible to others", deprecate: "visible to others" },
  };
}

const GH_READ = new Set(["view", "list", "diff", "checks", "status", "watch", "download"]);
// Tools where every subcommand not in `allow` changes the system: ask instead of classify.
const ASK_BY_DEFAULT: Record<string, string> = {
  systemctl: "changes a system service",
  loginctl: "changes a login session",
};

// Commands that always need a prompt.
const ALWAYS_ASK: Record<string, string> = {
  sudo: "runs as root", doas: "runs as root", su: "switches user", pkexec: "runs as root",
  ssh: "runs on a remote host", scp: "copies to or from a remote host", sftp: "connects to a remote host",
  ftp: "connects to a remote host", telnet: "opens a raw network connection", nc: "opens a raw network connection",
  ncat: "opens a raw network connection", netcat: "opens a raw network connection", socat: "opens a raw network connection",
  shutdown: "powers off the machine", reboot: "reboots the machine", poweroff: "powers off the machine", halt: "halts the machine",
  stow: "changes symlinks in $HOME", mount: "changes mounts", umount: "changes mounts", swapon: "changes swap", swapoff: "changes swap",
  modprobe: "loads a kernel module", rmmod: "unloads a kernel module", insmod: "loads a kernel module",
  kill: "kills a process", pkill: "kills processes", killall: "kills processes",
  iptables: "changes the firewall", nft: "changes the firewall", ufw: "changes the firewall", "firewall-cmd": "changes the firewall",
  useradd: "changes user accounts", usermod: "changes user accounts", userdel: "changes user accounts", passwd: "changes a password", visudo: "changes sudo rules",
  apt: "changes system packages", "apt-get": "changes system packages", dnf: "changes system packages", yum: "changes system packages",
  zypper: "changes system packages", snap: "changes system packages", flatpak: "changes system packages", brew: "changes system packages",
  twine: "uploads a package", fdisk: "edits disk partitions", parted: "edits disk partitions", sgdisk: "edits disk partitions",
};

// Commands whose operands are written to. "last" means only the final operand is a destination.
const WRITERS: Record<string, "all" | "last"> = {
  cp: "last", ln: "last", install: "last", rsync: "last",
  mv: "all", tee: "all", truncate: "all", touch: "all", mkdir: "all", rmdir: "all", chmod: "all",
  chown: "all", chgrp: "all", setfacl: "all", shred: "all", unlink: "all", patch: "all",
};
// The first operand of these is a mode, owner or script, not a path.
const FIRST_OPERAND_NOT_PATH = new Set(["chmod", "chown", "chgrp", "sed"]);

const WRAPPERS = new Set(["env", "nice", "ionice", "timeout", "time", "command", "builtin", "nohup", "setsid", "stdbuf", "exec", "chrt", "taskset"]);
const KEYWORDS = new Set(["if", "then", "elif", "else", "do", "while", "until", "!", "{", "}"]);
const NOOP_KEYWORDS = new Set(["fi", "done", "esac", "for", "in"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const INTERPRETERS = new Set(["python", "python3", "node", "perl", "ruby", "php", "lua", "deno", "bun"]);
const PY_MODULES = new Set(["pytest", "unittest", "venv", "pip", "build", "ruff", "mypy", "black", "isort", "compileall", "json.tool"]);
// tool -> subcommand that runs the rest of the line as a command.
const RUNNERS: Record<string, string> = { uv: "run", poetry: "run", pipenv: "run", pdm: "run", hatch: "run", pnpm: "exec", bundle: "exec" };

const operands = (args: string[]) => args.filter((a) => !a.startsWith("-"));
// Drops a wrapper's leading options; `takesValue` matches the ones followed by a value.
function afterFlags(args: string[], takesValue: RegExp): string[] {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) i += takesValue.test(args[i]) ? 2 : 1;
  return args.slice(i);
}
const hasFlag = (args: string[], short: string, long?: string) =>
  args.some((a) => (long && a === long) || (/^-[a-zA-Z]+$/.test(a) && a.includes(short)));

// ---- rules for one simple command ----

function writeTargets(cmd: string, args: string[], scope: Scope): Verdict {
  let targets = operands(args);
  if (FIRST_OPERAND_NOT_PATH.has(cmd)) targets = targets.slice(1);
  if (WRITERS[cmd] === "last") targets = targets.slice(-1);
  for (const t of targets) {
    const p = resolveWord(t, scope);
    if (isGuarded(p, scope)) return guardAsk(`${cmd} changes the auto-mode guard's own files`);
    if (!isLocal(p, scope)) return ask(`${cmd} writes outside the working directory: ${t}`);
  }
  return ALLOW;
}

function rm(args: string[], scope: Scope): Verdict {
  const recursive = hasFlag(args, "r", "--recursive") || hasFlag(args, "R");
  let verdict = ALLOW;
  for (const t of operands(args)) {
    const p = resolveWord(t, scope);
    const bare = BARE_GLOB.test(path.basename(t));
    if (recursive && p && (isRootLike(p) || (bare && isRootLike(path.dirname(p))))) {
      return deny(`rm -r of ${t} would wipe a home or system directory`);
    }
    if (isGuarded(p, scope)) verdict = worst(verdict, guardAsk("rm deletes the auto-mode guard's own files"));
    else if (!isLocal(p, scope)) verdict = worst(verdict, ask(`rm deletes outside the working directory: ${t}`));
    else if (recursive && scope.root && (p === scope.root || (bare && path.dirname(p!) === scope.root) || /(^|\/)\.git(\/|$)/.test(p!))) {
      verdict = worst(verdict, ask(`rm -r of ${t} deletes the whole project or its git data`));
    }
  }
  return verdict;
}

function git(args: string[], scope: Scope): Verdict {
  // Skip global options to find the subcommand.
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    if (args[i] === "-C") {
      if (!isLocal(resolveWord(args[i + 1] ?? "", scope), scope)) return classify("git on a repository outside the working directory");
      i += 2;
    } else i += args[i] === "-c" ? 2 : 1;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  const has = (...flags: string[]) => rest.some((a) => flags.includes(a));
  if (!sub) return ALLOW;
  if (sub === "reset" && has("--hard")) return ask("git reset --hard discards local changes");
  if (sub === "clean" && rest.some((a) => /^-[a-zA-Z]*f/.test(a) || a === "--force")) return ask("git clean -f deletes untracked files");
  if (sub === "checkout" && (has("--", ".") || has("-f", "--force"))) return ask("git checkout discards local changes");
  if (sub === "restore" && !has("--staged", "-S")) return ask("git restore discards local changes");
  if (sub === "branch") return has("-D") || (has("-d", "--delete") && has("-f", "--force")) ? ask("git branch -D deletes a branch") : ALLOW;
  if (sub === "stash") return has("drop", "clear") ? ask("git stash drop deletes stashed changes") : ALLOW;
  if (sub === "tag") return has("-d", "--delete") ? ask("git tag -d deletes a tag") : ALLOW;
  if (sub === "reset" || sub === "clean" || sub === "checkout" || sub === "restore") return ALLOW;
  if (sub === "config") {
    if (has("--global", "--system")) return has("--get", "--get-all", "--list", "-l") ? ALLOW : ask("changes git config outside the repository");
    return ALLOW;
  }
  if (sub === "remote") return has("add", "set-url", "remove", "rm", "rename") ? ask("changes where git pushes and fetches") : ALLOW;
  if (sub === "reflog") return has("expire", "delete") ? ask("deletes git recovery data") : ALLOW;
  if (sub === "gc") return has("--prune=now", "--aggressive") ? ask("deletes git recovery data") : ALLOW;
  return subcommand("git", [sub, ...rest]);
}

function gh(args: string[]): Verdict {
  const [group, action] = operands(args);
  if (!group) return ALLOW;
  if (group === "api") {
    const m = args.findIndex((a) => a === "-X" || a === "--method");
    const method = m >= 0 ? (args[m + 1] ?? "").toUpperCase() : args.find((a) => /^-X\w+$/.test(a))?.slice(2).toUpperCase();
    const fields = args.some((a) => /^(-f|-F|--field|--raw-field|--input)(=|$)/.test(a));
    if (method ? method !== "GET" : fields) return ask("gh api call that changes remote data");
    return ALLOW;
  }
  if (group === "auth") return action === "status" ? ALLOW : classify("gh auth");
  if (["pr", "issue", "release", "repo", "run", "workflow", "gist", "label", "project", "secret", "variable", "cache"].includes(group)) {
    if (action && GH_READ.has(action)) return ALLOW;
    if (group === "repo" && action === "clone") return ALLOW;
    return ask(`gh ${group} ${action ?? ""} is visible to others`.replace(/\s+/g, " "));
  }
  return subcommand("gh", args);
}

function subcommand(tool: string, args: string[]): Verdict {
  const table = SUBCOMMANDS[tool];
  const sub = operands(args)[0];
  if (!sub) return ALLOW;
  if (table.ask?.[sub]) return ask(table.ask[sub]);
  if (table.allow.split(/\s+/).includes(sub)) return ALLOW;
  return ASK_BY_DEFAULT[tool] ? ask(`${tool} ${sub} ${ASK_BY_DEFAULT[tool]}`) : classify(`${tool} ${sub}`);
}

function network(cmd: string, args: string[], scope: Scope): Verdict {
  if (cmd === "curl") {
    if (args.some((a) => /^(-d|--data|--data-\w+|--json|-F|--form|--form-string|-T|--upload-file)(=|$)/.test(a) || /^-[a-zA-Z]*[dFT]/.test(a))) {
      return ask("curl sends data to a remote host");
    }
    const m = args.findIndex((a) => a === "-X" || a === "--request");
    const method = m >= 0 ? args[m + 1] : args.find((a) => /^-X\w+$/.test(a))?.slice(2);
    if (method && !/^(GET|HEAD|OPTIONS)$/i.test(method)) return ask(`curl -X ${method} changes remote data`);
  } else if (args.some((a) => /^--(post|body|method)/.test(a))) {
    return ask("wget sends data to a remote host");
  }
  // A URL or header built from a variable or a substitution can carry local data out.
  if (args.some((a) => /[$`]/.test(a))) return ask(`${cmd} request built from local data`);
  const outFlags = cmd === "curl" ? ["-o", "--output"] : ["-O", "--output-document"];
  const o = args.findIndex((a) => outFlags.includes(a));
  if (o >= 0 && args[o + 1] !== "-" && !isLocal(resolveWord(args[o + 1] ?? "", scope), scope)) {
    return ask(`${cmd} writes outside the working directory`);
  }
  // wget, and curl -O, save into the current directory.
  const savesToCwd = cmd === "wget" ? o < 0 : args.some((a) => a === "--remote-name" || /^-[a-zA-Z]*O/.test(a));
  return savesToCwd && !isLocal(scope.cwd, scope) ? ask(`${cmd} writes outside the working directory`) : ALLOW;
}

function find(args: string[], scope: Scope): Verdict {
  const firstOption = args.findIndex((a) => /^(-|\(|!)/.test(a));
  const roots = firstOption < 0 ? args : args.slice(0, firstOption);
  const acts = args.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)$/.test(a));
  if (!acts) return ALLOW;
  for (const r of roots.length ? roots : ["."]) {
    if (!isLocal(resolveWord(r, scope), scope)) return ask(`find deletes or runs commands outside the working directory: ${r}`);
  }
  const exec = args.findIndex((a) => /^-(exec|execdir|ok|okdir)$/.test(a));
  if (exec < 0) return classify("find -delete");
  const end = args.findIndex((a, i) => i > exec && (a === ";" || a === "+"));
  // {} stands for a path under the search roots, which were checked above.
  const inner = args.slice(exec + 1, end < 0 ? undefined : end).map((a) => (a === "{}" ? "." : a));
  return worst(classify("find -exec"), simple({ argv: inner, out: [] }, scope, 1));
}

// Drops leading keywords, VAR=value assignments and wrappers such as `timeout 60` or `env`.
// Empty when nothing is left to run.
function unwrap(words: string[]): string[] {
  const argv = [...words];
  for (;;) {
    while (argv.length && (KEYWORDS.has(argv[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0]))) argv.shift();
    if (!argv.length || NOOP_KEYWORDS.has(argv[0])) return [];
    if (!WRAPPERS.has(path.basename(argv[0]))) return argv;
    argv.shift();
    // Wrapper options and their values: flags, numbers, durations, VAR=value.
    while (argv.length && /^(-.*|\d+(\.\d+)?[smhd]?|[A-Za-z_][A-Za-z0-9_]*=.*)$/.test(argv[0])) argv.shift();
  }
}

function redirects(cmd: Simple, scope: Scope): Verdict {
  let verdict = ALLOW;
  for (const target of cmd.out) {
    const p = resolveWord(target, scope);
    if (p && DEV_SINKS.test(p)) continue;
    if (p && /^\/dev\//.test(p)) return deny(`writes to the device ${target}`);
    if (isGuarded(p, scope)) verdict = worst(verdict, guardAsk("redirect overwrites the auto-mode guard's own files"));
    else if (!isLocal(p, scope)) verdict = worst(verdict, ask(`redirect writes outside the working directory: ${target}`));
  }
  return verdict;
}

// Redirect targets are always checked by the built-in rules (allowedPaths is the way to open
// a directory). For the command itself a user rule replaces the built-in verdict.
function simple(cmd: Simple, scope: Scope, depth = 0): Verdict {
  const out = redirects(cmd, scope);
  if (out.action === "deny") return out;
  const builtin = command(cmd, scope, depth);
  if (builtin.action === "deny" || builtin.locked || !scope.rules) return worst(out, builtin);
  return worst(out, userVerdict(cmd.argv, scope.rules) ?? builtin);
}

function command(cmd: Simple, scope: Scope, depth: number): Verdict {
  let verdict = ALLOW;
  const argv = unwrap(cmd.argv);
  if (!argv.length) return verdict;

  const name = path.basename(argv[0]);
  const args = argv.slice(1);

  if (["case", "function", "select", "source", ".", "trap", "alias"].includes(name)) return worst(verdict, classify(`shell ${name}`));
  if (/^mkfs(\.|$)/.test(name) || name === "wipefs") return deny(`${name} formats a disk`);

  // The guard's own files: only read-only commands may name them.
  if (!READ_ONLY.has(name) && args.some((a) => isGuarded(resolveWord(a.replace(/^[^=]*=/, ""), scope), scope))) {
    verdict = worst(verdict, guardAsk(`${name} touches the auto-mode guard's own files`));
  }

  if (name === "sudo" || name === "doas") {
    const inner = afterFlags(args, /^-[ugCDhpRrTU]$/);
    return worst(verdict, ask(`${name} runs as root`), inner.length ? simple({ argv: inner, out: [] }, scope, depth + 1) : ALLOW);
  }
  if (ALWAYS_ASK[name]) return worst(verdict, ask(`${name} ${ALWAYS_ASK[name]}`));
  if (args.length === 1 && /^(--version|-V|--help|-h)$/.test(args[0])) return verdict;

  if (SHELLS.has(name)) {
    if (args[0] === "-n") return verdict;
    const c = args.findIndex((a) => /^-[a-zA-Z]*c$/.test(a));
    if (c < 0 || depth > 3) return worst(verdict, classify(`runs a script with ${name}`));
    return worst(verdict, evaluateParsed(parse(args[c + 1] ?? ""), scope, depth + 1));
  }
  if (name === "eval") return worst(verdict, evaluateParsed(parse(args.join(" ")), scope, depth + 1));
  // `uv run pytest` and similar: the rest of the line is the command.
  if (RUNNERS[name] && operands(args)[0] === RUNNERS[name]) {
    const inner = afterFlags(args.slice(args.indexOf(RUNNERS[name]) + 1), /^(--with|--python|-p|--project|--group|--extra|--env-file|--directory)$/);
    return worst(verdict, inner.length ? simple({ argv: inner, out: [] }, scope, depth + 1) : ALLOW);
  }
  if (name === "rsync" && operands(args).some((a) => /^[\w.@-]+:/.test(a))) return worst(verdict, ask("rsync copies to or from a remote host"));
  if (name === "xargs") {
    const inner = afterFlags(args, /^-[InPLsdE]$/);
    return worst(verdict, classify("xargs"), inner.length ? simple({ argv: [...inner, "$()"], out: [] }, scope, depth + 1) : ALLOW);
  }
  if (name === "cd" || name === "pushd" || name === "popd") return verdict;

  if (name === "rm") return worst(verdict, rm(args, scope));
  if (name === "dd") {
    const of = args.find((a) => a.startsWith("of="))?.slice(3);
    if (of === undefined) return worst(verdict, classify("dd"));
    const p = resolveWord(of, scope);
    if (p && /^\/dev\//.test(p) && !DEV_SINKS.test(p)) return deny(`dd writes to the device ${of}`);
    return worst(verdict, isLocal(p, scope) ? classify("dd") : ask(`dd writes outside the working directory: ${of}`));
  }
  if ((name === "chmod" || name === "chown" || name === "chgrp") && hasFlag(args, "R", "--recursive")) {
    for (const t of operands(args).slice(1)) {
      const p = resolveWord(t, scope);
      if (p && isRootLike(p)) return deny(`${name} -R on ${t} would change a home or system directory`);
    }
  }
  if (name === "sed") return worst(verdict, args.some((a) => /^(-i|--in-place)/.test(a) || /^-[a-zA-Z]*i/.test(a)) ? writeTargets("sed", args, scope) : ALLOW);
  if (name === "awk" || name === "gawk") return worst(verdict, args.some((a) => /system\s*\(|\|\s*"|>\s*"/.test(a)) ? classify("awk that runs commands or writes files") : ALLOW);
  if (WRITERS[name]) return worst(verdict, writeTargets(name, args, scope));
  if (name === "tar" || name === "zip" || name === "unzip" || name === "gzip" || name === "gunzip" || name === "xz" || name === "zstd") {
    // Archives read and write paths given as operands and after -f / -C / -d.
    for (const a of args.filter((x) => !x.startsWith("-"))) {
      if (!isLocal(resolveWord(a, scope), scope)) return worst(verdict, classify(`${name} with a path outside the working directory`));
    }
    return verdict;
  }
  if (name === "curl" || name === "wget") return worst(verdict, network(name, args, scope));
  if (name === "find") return worst(verdict, find(args, scope));
  if (name === "git") return worst(verdict, git(args, scope));
  if (name === "gh") return worst(verdict, gh(args));
  if (name === "crontab") return worst(verdict, args.length === 1 && args[0] === "-l" ? ALLOW : ask("crontab changes scheduled jobs"));
  if (name === "sysctl") return worst(verdict, args.some((a) => a === "-w" || a.includes("=")) ? ask("sysctl changes kernel settings") : ALLOW);
  if (name === "pacman" || name === "paru" || name === "yay") {
    return worst(verdict, /^-(Q|Ss|Si|Sl|Sg|F|T|V|h)/.test(args[0] ?? "-h") ? ALLOW : ask(`${name} changes system packages`));
  }
  if (name === "npm" && operands(args)[0] === "config" && ["set", "delete", "edit"].includes(operands(args)[1])) {
    return worst(verdict, ask("npm config changes settings outside the project"));
  }
  if (name === "docker" && ["compose", "buildx"].includes(operands(args)[0])) return worst(verdict, classify(`docker ${operands(args)[0]}`));
  if (SUBCOMMANDS[name]) return worst(verdict, subcommand(name, args));
  if (READ_ONLY.has(name) || DEV_TOOLS.has(name)) return verdict;
  if (/^python3?$/.test(name) && args[0] === "-m" && PY_MODULES.has(args[1]) && !cmd.heredoc) return verdict;
  if (INTERPRETERS.has(name)) return worst(verdict, classify(`runs code with ${name}`));
  return worst(verdict, classify(`unknown command ${name}`));
}

// ---- whole tool calls ----

const FORK_BOMB = /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/;
const PIPE_TO_SHELL = /\b(curl|wget)\b[^|;&\n]*\|\s*(sudo\s+)?(env\s+)?(ba|z|da|k)?sh\b|\b(curl|wget)\b[^|;&\n]*\|\s*(python3?|node|perl|ruby)\b/;

function evaluateParsed(parsed: Parsed, scope: Scope, depth: number): Verdict {
  let verdict: Verdict = parsed.opaque ? classify("shell syntax the rules do not model") : ALLOW;
  // Relative paths are only trusted while the working directory is known.
  const local: Scope = { ...scope };
  const hasCd = parsed.cmds.some((c) => ["cd", "pushd", "popd"].includes(c.argv[0]));
  if (hasCd && parsed.grouped) local.cwd = undefined;
  for (const cmd of parsed.cmds) {
    verdict = worst(verdict, simple(cmd, local, depth));
    if (verdict.action === "deny") return verdict;
    if (cmd.argv[0] === "cd" && local.cwd) {
      local.cwd = cmd.argv.length === 2 ? resolveWord(cmd.argv[1], local) : cmd.argv.length === 1 ? HOME : undefined;
    } else if (cmd.argv[0] === "pushd" || cmd.argv[0] === "popd") local.cwd = undefined;
  }
  return verdict;
}

export function bashVerdict(command: string, scope: Scope): Verdict {
  if (FORK_BOMB.test(command)) return deny("fork bomb");
  const verdict = evaluateParsed(parse(command), scope, 0);
  if (verdict.action === "deny") return verdict;
  return PIPE_TO_SHELL.test(command) ? worst(verdict, ask("downloads code and runs it")) : verdict;
}

// write and edit tools.
export function fileVerdict(tool: string, target: string, scope: Scope): Verdict {
  const p = resolveWord(target.startsWith("@") ? target.slice(1) : target, scope);
  if (isGuarded(p, scope)) return guardAsk(`${tool} changes the auto-mode guard's own files`);
  return isLocal(p, scope) ? ALLOW : ask(`${tool} outside the working directory: ${target}`);
}
