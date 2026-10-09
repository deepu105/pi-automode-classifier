// Deterministic rules for pi-automode-classifier. They run before the model and settle
// most tool calls:
//   deny     - blocked outright (wipes of /, $HOME or a system directory, disk formatting)
//   ask      - needs a confirm prompt (root, remote or outward-facing actions, deletes and
//              writes outside the working directory, reads of credential files, edits to this
//              guard's own files)
//   allow    - read-only commands, builds and tests, file changes inside the working directory,
//              running a file of the project or one the agent wrote in this session
//   classify - everything else goes to the decision model
//
// A compound command gets the most severe verdict of its parts. Command substitutions and
// `sh -c` strings are parsed as commands too. Syntax the parser does not model (unbalanced
// quotes) is never allowed by rule.
//
// User rules (UserRules) replace the built-in verdict of a simple command. Two things they
// cannot replace: a built-in deny, and the ask for changes to the guard's own files.
//
// The rules also follow which files a session wrote or downloaded (Scope.files), so a script
// the agent wrote runs without the model and a downloaded one asks. Only writes the rules can
// see are followed: redirects, cp, mv, tee, curl and wget, not what a program writes itself.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Action = "allow" | "classify" | "ask" | "deny";
export interface Verdict {
  action: Action;
  reason: string;
  // A user allow rule cannot replace this verdict.
  locked?: boolean;
  // Set when the call asks because it changes something outside the working directory: the
  // folder a "for this session" permission would cover.
  dir?: string;
  // Set when one command the rules do not know sent the call to the model: an allow pattern
  // for it that the confirm prompt can offer.
  pattern?: string;
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

// Where the content of a file written in this session came from: the agent itself (write tool,
// heredoc, echo, printf), a download, or a command whose output the rules cannot know.
export type Origin = "authored" | "fetched" | "other";
export type SessionFiles = Map<string, Origin>;

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
  // Files written by earlier calls of the session.
  files: SessionFiles;
  // Files the call being checked would write. commitWrites() adds them to `files` once the
  // call is allowed to run.
  pending: SessionFiles;
  // True for a file of the project checkout: tracked or ignored by the session's git repository.
  project?: (p: string) => boolean;
}

const expandHome = (p: string) => (p === "~" || p.startsWith("~/") ? HOME + p.slice(1) : p);
const withTargets = (paths: string[]) => [...new Set(paths.map(expandHome).flatMap((p) => [p, realish(p)]))];

export interface ScopeOptions {
  allowedPaths?: string[];
  rules?: UserRules;
  files?: SessionFiles;
  project?: (p: string) => boolean;
}

export function makeScope(cwd: string, guarded: string[], options: ScopeOptions = {}): Scope {
  const real = realish(cwd);
  return {
    cwd: real,
    root: within(HOME, real) ? undefined : real,
    guarded: withTargets(guarded),
    allowed: withTargets(options.allowedPaths ?? []),
    rules: options.rules,
    files: options.files ?? new Map(),
    pending: new Map(),
    project: options.project,
  };
}

// Call after a checked tool call was allowed to run.
export function commitWrites(scope: Scope) {
  for (const [p, origin] of scope.pending) scope.files.set(p, origin);
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
// `FOO=1`). An allow rule must match the command as written, or without the shell keywords
// and wrappers that do not change what runs (`then`, `timeout 60`, `nice`). It does not match
// behind `env` or a VAR=value assignment, which can change what runs.
function userVerdict(argv: string[], rules: UserRules): Verdict | undefined {
  const raw = argv.join(" ");
  const bare = unwrap(argv).join(" ");
  for (const action of ["deny", "ask", "classify"] as const) {
    const hit = rules[action].find((m) => m.test(raw) || m.test(bare));
    if (hit) return { action, reason: `your ${action} rule "${hit.source}"` };
  }
  const plain = unwrap(argv, SAME_PROGRAM_WRAPPERS).join(" ");
  return rules.allow.some((m) => m.test(raw) || (plain !== "" && m.test(plain))) ? ALLOW : undefined;
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
export const isRootLike = (p: string) => p === "/" || path.dirname(p) === "/" || within(HOME, p);
const BARE_GLOB = /^(\*|\.\*|\.\[!\.\]\*|\{.*\})$/;

// The folder a session permission for `p` would cover: the git checkout or worktree it is in,
// else its parent directory. Undefined for /, $HOME and system directories, which are never
// opened as a whole.
function folderFor(p: string | undefined): string | undefined {
  if (!p) return undefined;
  const parent = path.dirname(p);
  for (let d = parent; !isRootLike(d); d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, ".git"))) return d;
  }
  return isRootLike(parent) ? undefined : parent;
}
// An ask for a change outside the working directory, with the folder it could be allowed for.
const outside = (reason: string, p: string | undefined): Verdict => ({ action: "ask", reason, dir: folderFor(p) });

// ---- files of the session ----

const originOf = (p: string, scope: Scope) => scope.pending.get(p) ?? scope.files.get(p);
// Records that the call writes `p`. A download stays one until the agent rewrites the whole file.
function note(p: string | undefined, origin: Origin, scope: Scope) {
  if (p && !(origin === "other" && originOf(p, scope) === "fetched")) scope.pending.set(p, origin);
}
const isFetched = (word: string, scope: Scope) => {
  const p = resolveWord(word, scope);
  return !!p && originOf(p, scope) === "fetched";
};

// A script with one of these in its name or arguments stays with the model, even when it is
// a file of the project.
const OUTWARD_WORDS = /deploy|publish|release|upload|prod/i;

// Verdict for running the file `word` with `args`, or undefined when the rules cannot tell.
// A file the agent wrote in this session and a file of the project checkout are allowed: they
// run the same code as the project's build and tests. A download asks.
function runFile(word: string, args: string[], scope: Scope): Verdict | undefined {
  const p = resolveWord(word, scope);
  if (!p) return undefined;
  const origin = originOf(p, scope);
  if (origin === "fetched") return ask(`runs a file downloaded in this session: ${word}`);
  if (isGuarded(p, scope) || !isLocal(p, scope) || OUTWARD_WORDS.test([path.basename(word), ...args].join(" "))) return undefined;
  if (origin === "authored") return ALLOW;
  return origin === undefined && scope.project?.(p) ? ALLOW : undefined;
}

// ---- credentials ----

// Places that hold credentials, in any home directory, and file names that do so anywhere.
// Reading one puts it into the agent's transcript, so it asks even for a read-only command.
const SECRET_PLACES = [
  /\/\.(ssh|aws|gnupg|kube|azure|oci|password-store)(\/|$)/,
  /\/\.config\/(gcloud|op|gh\/hosts\.yml)(\/|$)/,
  /\/\.docker\/config\.json$/,
  /\/\.cargo\/credentials(\.toml)?$/,
  /\/\.terraform\.d\/credentials\.tfrc\.json$/,
  /\/\.local\/share\/keyrings(\/|$)/,
  /\/Library\/Keychains(\/|$)/,
  /^\/etc\/(g?shadow-?|ssl\/private(\/.*)?|ssh\/ssh_host_\w+_key)$/,
  /^\/proc\/[^/]+\/environ$/,
];
const SECRET_NAMES =
  /^(id_(rsa|dsa|ecdsa|ed25519)(_[\w.-]+)?|.+\.(pem|key|p12|pfx|jks|keystore|kdbx)|\.env(\.[\w.-]+)?|credentials\.(json|ya?ml|toml|ini|csv|xml)|secrets?\.(json|ya?ml|toml|ini|env|txt)|.*service[-_]?(account|principal).*\.json|\.(netrc|npmrc|pypirc|git-credentials|vault-token|pgpass|htpasswd)|\.(bash|zsh)_history|.*\.keychain(-db)?)$/i;

function isSecretPath(p: string): boolean {
  const name = path.basename(p);
  // Public keys, host lists, client settings, env templates and certificates hold nothing secret.
  if (/\.pub$|^known_hosts|^authorized_keys$|^\.env\.(example|sample|template|dist|defaults?)$/i.test(name)) return false;
  if (/\/\.(ssh|aws)\/config$/.test(p)) return false;
  if (/cert|chain|public|(^|[._-])ca([._-]|$)/i.test(name) && !/priv|key/i.test(name.replace(/\.key$/i, ""))) return false;
  return SECRET_PLACES.some((place) => place.test(p)) || SECRET_NAMES.test(name);
}

// The credential file a shell word names, if any. Handles `--file=path`, curl's `@file` and
// git's `rev:path`. In a command, words with spaces and URLs are text, not paths.
function secretIn(word: string, scope: Scope, isPath = false): string | undefined {
  if (!isPath && (/\s/.test(word) || /^[a-z][a-z0-9+.-]*:\/\//i.test(word))) return undefined;
  const text = word.replace(/^[^=/]*=/, "").replace(/^@/, "");
  for (const candidate of new Set([text, text.slice(text.lastIndexOf(":") + 1)])) {
    if (!candidate || candidate.startsWith("-")) continue;
    const p = resolveWord(candidate, scope);
    if (isSecretPath(expandHome(candidate)) || (p && isSecretPath(p))) return candidate;
  }
  return undefined;
}

// Commands that name a path without showing what is in it.
const NAMES_ONLY = new Set(
  `ls stat test [ file du find readlink realpath basename dirname which echo printf rm rmdir unlink mkdir
   touch chmod chown chgrp setfacl tee truncate shred`.split(/\s+/),
);
// The first operand of these is a pattern, filter or script, not a file.
const PATTERN_FIRST = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack", "sed", "awk", "gawk", "jq", "yq"]);

// The credential file a simple command would read, if any.
function credentialRead(name: string, args: string[], cmd: Simple, scope: Scope): string | undefined {
  if (NAMES_ONLY.has(name)) return undefined;
  // An in-place edit shows nothing, and a destination is written, not read.
  if (name === "sed" && args.some((a) => /^(-i|--in-place)/.test(a) || /^-[a-zA-Z]*i/.test(a))) return undefined;
  let words = args;
  if (PATTERN_FIRST.has(name)) words = operands(args).slice(1);
  else if (COPIERS.has(name)) words = operands(args).slice(0, -1);
  // `--env-file .env` hands the file to a program and shows nothing.
  words = words.filter((w, i) => !/^--env-file(=|$)/.test(w) && words[i - 1] !== "--env-file");
  for (const word of [...words, ...(cmd.in ?? [])]) {
    const secret = secretIn(word, scope);
    if (secret) return secret;
  }
  return undefined;
}

// ---- parser ----

export interface Simple {
  argv: string[];
  // Output redirect targets.
  out: string[];
  // Input redirect sources.
  in?: string[];
  // The targets in `out` opened with `>>`.
  append?: string[];
  // Reads a heredoc: for a shell or interpreter the body is code.
  heredoc?: boolean;
  // The heredoc body holds a variable or a command substitution, so it is not literal text.
  expands?: boolean;
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
  let redirect: "" | "out" | "append" | "in" = "";
  // Heredocs opened on the current line. A body is data and is skipped, except that the shell
  // runs the substitutions in a body whose delimiter is not quoted.
  const heredocs: { delimiter: string; quoted: boolean; owner: Simple }[] = [];

  const pushWord = () => {
    if (hasWord) {
      const expanded = word.replace(/\$\{HOME\}|\$HOME\b/g, HOME);
      if (redirect === "out" || redirect === "append") cur.out.push(expanded);
      else if (redirect === "") cur.argv.push(expanded);
      else (cur.in ??= []).push(expanded);
      if (redirect === "append") (cur.append ??= []).push(expanded);
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
  // Parses a substitution body as extra commands.
  const absorb = (inner: string) => {
    const sub = parse(inner, depth + 1);
    result.cmds.push(...sub.cmds);
    result.opaque ||= sub.opaque;
    result.grouped = true;
  };
  // The same, and leaves a placeholder in the word.
  const nested = (inner: string) => {
    absorb(inner);
    word += "$()";
    hasWord = true;
  };
  // The substitutions the shell runs inside an unquoted heredoc body.
  const heredocBody = (body: string, owner: Simple) => {
    if (/[$`]/.test(body)) owner.expands = true;
    for (let j = 0; j < body.length; j++) {
      if (body[j] === "\\") j++;
      else if (body[j] === "$" && body[j + 1] === "(") {
        const end = matchParen(body, j + 1);
        if (end < 0) return void (result.opaque = true);
        absorb(body.slice(j + 2, end));
        j = end;
      } else if (body[j] === "`") {
        const end = body.indexOf("`", j + 1);
        if (end < 0) return void (result.opaque = true);
        absorb(body.slice(j + 1, end));
        j = end;
      }
    }
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
        heredocs.push({ delimiter: heredoc[2], quoted: heredoc[1] !== "", owner: cur });
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
      const append = s[i + 1] === ">";
      if (append || s[i + 1] === "|") i++;
      if (s[i + 1] === "&") {
        // fd duplication such as 2>&1 has no file target.
        i++;
        while (/[\d-]/.test(s[i + 1] ?? "")) i++;
      } else redirect = append ? "append" : "out";
    } else if (c === " " || c === "\t") {
      pushWord();
    } else if (c === "\n" || c === ";") {
      pushCmd();
      while (c === "\n" && heredocs.length) {
        const doc = heredocs.shift()!;
        const end = new RegExp(`^\\s*${doc.delimiter.replace(/[.\-]/g, "\\$&")}\\s*$`, "m").exec(s.slice(i + 1));
        if (!doc.quoted) heredocBody(end ? s.slice(i + 1, i + 1 + end.index) : s.slice(i + 1), doc.owner);
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
   journalctl dmesg ss dig nslookup ping getent locale zcat xzcat bzcat zstdcat
   set shopt local declare typeset readonly break continue return exit shift :`.split(/\s+/),
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
      fetch vendor expand audit deny outdated machete info search pkgid locate-project version help`,
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
// docker <group> <action>: the actions of each group that only read.
const DOCKER_GROUPS: Record<string, string> = {
  image: "ls list inspect history",
  container: "ls list inspect logs top stats port diff",
  network: "ls list inspect",
  volume: "ls list inspect",
  context: "ls list inspect show",
  system: "df info",
};
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
// Writers whose destination gets the content of their source, and the other writers that
// change a file's content.
const COPIERS = new Set(["cp", "mv", "ln", "install", "rsync"]);
const CONTENT_WRITERS = new Set(["tee", "truncate", "shred", "patch"]);

const WRAPPERS = new Set(["env", "nice", "ionice", "timeout", "time", "command", "builtin", "nohup", "setsid", "stdbuf", "exec", "chrt", "taskset"]);
// Wrappers that run the same program with the same environment and PATH lookup.
const SAME_PROGRAM_WRAPPERS = new Set(["timeout", "time", "nice", "ionice", "nohup", "setsid", "stdbuf"]);
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

function writeTargets(cmd: string, args: string[], scope: Scope, literalInput = false): Verdict {
  const paths = FIRST_OPERAND_NOT_PATH.has(cmd) ? operands(args).slice(1) : operands(args);
  const targets = WRITERS[cmd] === "last" ? paths.slice(-1) : paths;
  for (const t of targets) {
    const p = resolveWord(t, scope);
    if (isGuarded(p, scope)) return guardAsk(`${cmd} changes the auto-mode guard's own files`);
    if (!isLocal(p, scope)) return outside(`${cmd} writes outside the working directory: ${t}`, p);
  }
  if (COPIERS.has(cmd) && paths.length > 1) {
    const sources = paths.slice(0, -1);
    const dest = resolveWord(paths.at(-1)!, scope);
    const intoDir = sources.length > 1 || paths.at(-1)!.endsWith("/") || (!!dest && fs.statSync(dest, { throwIfNoEntry: false })?.isDirectory());
    for (const source of sources) {
      const from = resolveWord(source, scope);
      const kept = from && originOf(from, scope);
      note(dest && intoDir ? path.join(dest, path.basename(source)) : dest, kept === "authored" || kept === "fetched" ? kept : "other", scope);
      if (cmd === "mv") note(from, "other", scope);
    }
  } else if (CONTENT_WRITERS.has(cmd)) {
    const literal = cmd === "tee" && literalInput;
    // Appending literal text leaves the file's origin as it was.
    if (!(literal && hasFlag(args, "a", "--append"))) for (const t of targets) note(resolveWord(t, scope), literal ? "authored" : "other", scope);
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
    else if (!isLocal(p, scope)) verdict = worst(verdict, outside(`rm deletes outside the working directory: ${t}`, p));
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
  return ASK_BY_DEFAULT[tool] ? ask(`${tool} ${sub} ${ASK_BY_DEFAULT[tool]}`) : { ...classify(`${tool} ${sub}`), pattern: `${tool} ${sub} *` };
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
  if (o >= 0 && args[o + 1] !== "-") {
    const p = resolveWord(args[o + 1] ?? "", scope);
    if (!(p && DEV_SINKS.test(p))) {
      if (!isLocal(p, scope)) return outside(`${cmd} writes outside the working directory: ${args[o + 1] ?? ""}`, p);
      note(p, "fetched", scope);
    }
  }
  // wget, and curl -O, save into the current directory under the URL's file name.
  const savesToCwd = cmd === "wget" ? o < 0 : args.some((a) => a === "--remote-name" || /^-[a-zA-Z]*O/.test(a));
  if (!savesToCwd) return ALLOW;
  if (!isLocal(scope.cwd, scope)) return ask(`${cmd} writes outside the working directory`);
  for (const url of args.filter((a) => /^https?:\/\//.test(a))) {
    const file = path.basename(url.split(/[?#]/)[0]);
    if (file && scope.cwd) note(path.join(scope.cwd, file), "fetched", scope);
  }
  return ALLOW;
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
// Empty when nothing is left to run. With `only`, drops just the keywords and those wrappers
// (by exact name) and stops at an assignment.
function unwrap(words: string[], only?: Set<string>): string[] {
  const argv = [...words];
  const assignment = (word: string) => !only && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
  for (;;) {
    while (argv.length && (KEYWORDS.has(argv[0]) || assignment(argv[0]))) argv.shift();
    if (!argv.length || NOOP_KEYWORDS.has(argv[0])) return [];
    const wrapper = only ? argv[0] : path.basename(argv[0]);
    if (!(only ?? WRAPPERS).has(wrapper)) return argv;
    argv.shift();
    // `command -v name` looks a command up and runs nothing.
    if (wrapper === "command" && /^-[vV]$/.test(argv[0] ?? "")) return [];
    // Wrapper options and their values: flags, numbers, durations, VAR=value.
    while (argv.length && (/^(-.*|\d+(\.\d+)?[smhd]?)$/.test(argv[0]) || assignment(argv[0]))) argv.shift();
  }
}

// Where the output of a simple command comes from. Literal text is the agent's own: echo and
// printf without a variable or substitution, and cat of a heredoc.
function outputOrigin(cmd: Simple, scope: Scope): Origin {
  const [program = "", ...args] = unwrap(cmd.argv);
  const name = path.basename(program);
  if (name === "curl" || name === "wget") return "fetched";
  const literal = !cmd.expands && !args.some((a) => /[$`]/.test(a));
  if (literal && (name === "echo" || name === "printf" || (name === "cat" && cmd.heredoc && !operands(args).length))) return "authored";
  return args.some((a) => isFetched(a, scope)) ? "fetched" : "other";
}

function redirects(cmd: Simple, scope: Scope): Verdict {
  let verdict = ALLOW;
  const origin = cmd.out.length ? outputOrigin(cmd, scope) : "other";
  for (const target of cmd.out) {
    const p = resolveWord(target, scope);
    if (p && DEV_SINKS.test(p)) continue;
    if (p && /^\/dev\//.test(p)) return deny(`writes to the device ${target}`);
    if (isGuarded(p, scope)) verdict = worst(verdict, guardAsk("redirect overwrites the auto-mode guard's own files"));
    else if (!isLocal(p, scope)) verdict = worst(verdict, outside(`redirect writes outside the working directory: ${target}`, p));
    // Appending literal text leaves the file's origin as it was.
    if (!(origin === "authored" && cmd.append?.includes(target))) note(p, origin, scope);
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
  const secret = credentialRead(name, args, cmd, scope);
  if (secret) verdict = worst(verdict, ask(`${name} reads a credential file: ${secret}`));

  if (name === "sudo" || name === "doas") {
    const inner = afterFlags(args, /^-[ugCDhpRrTU]$/);
    return worst(verdict, ask(`${name} runs as root`), inner.length ? simple({ argv: inner, out: [] }, scope, depth + 1) : ALLOW);
  }
  if (ALWAYS_ASK[name]) return worst(verdict, ask(`${name} ${ALWAYS_ASK[name]}`));
  if (args.length === 1 && /^(--version|-V|--help|-h)$/.test(args[0])) return verdict;

  if (SHELLS.has(name)) {
    if (args[0] === "-n") return verdict;
    const c = args.findIndex((a) => /^-[a-zA-Z]*c$/.test(a));
    if (c >= 0 && depth <= 3) return worst(verdict, evaluateParsed(parse(args[c + 1] ?? ""), scope, depth + 1));
    const [script, ...rest] = afterFlags(args, /^[-+]o$/);
    return worst(verdict, (c < 0 && script && !cmd.heredoc && runFile(script, rest, scope)) || classify(`runs a script with ${name}`));
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
    return worst(verdict, isLocal(p, scope) ? classify("dd") : outside(`dd writes outside the working directory: ${of}`, p));
  }
  if ((name === "chmod" || name === "chown" || name === "chgrp") && hasFlag(args, "R", "--recursive")) {
    for (const t of operands(args).slice(1)) {
      const p = resolveWord(t, scope);
      if (p && isRootLike(p)) return deny(`${name} -R on ${t} would change a home or system directory`);
    }
  }
  if (name === "sed") return worst(verdict, args.some((a) => /^(-i|--in-place)/.test(a) || /^-[a-zA-Z]*i/.test(a)) ? writeTargets("sed", args, scope) : ALLOW);
  if (name === "awk" || name === "gawk") return worst(verdict, args.some((a) => /system\s*\(|\|\s*"|>\s*"/.test(a)) ? classify("awk that runs commands or writes files") : ALLOW);
  if (WRITERS[name]) return worst(verdict, writeTargets(name, args, scope, !!cmd.heredoc && !cmd.expands));
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
  if (name === "docker") {
    const [group, action] = operands(args);
    if (group === "compose" || group === "buildx") return worst(verdict, classify(`docker ${group}`));
    if (group && Object.hasOwn(DOCKER_GROUPS, group)) {
      return worst(verdict, DOCKER_GROUPS[group].split(" ").includes(action) ? ALLOW : classify(`docker ${group} ${action ?? ""}`.trim()));
    }
  }
  if (SUBCOMMANDS[name]) return worst(verdict, subcommand(name, args));
  if (READ_ONLY.has(name) || DEV_TOOLS.has(name)) return verdict;
  if (/^python3?$/.test(name) && args[0] === "-m" && PY_MODULES.has(args[1]) && !cmd.heredoc) return verdict;
  if (INTERPRETERS.has(name)) {
    // `python3 scripts/x.py`: the script is the first argument. Inline code (-c, -e, a heredoc) stays with the model.
    const script = !cmd.heredoc && args[0] && !args[0].startsWith("-") ? runFile(args[0], args.slice(1), scope) : undefined;
    return worst(verdict, script ?? classify(`runs code with ${name}`));
  }
  // A program named by its path, such as ./scripts/build.sh or target/debug/app.
  if (argv[0].includes("/")) {
    const program = runFile(argv[0], args, scope);
    if (program) return worst(verdict, program);
  }
  return worst(verdict, { ...classify(`unknown command ${name}`), pattern: allowPattern(argv) });
}

// The allow pattern a confirm prompt offers for a command the rules do not know: the command
// and its subcommand or first flag, such as `terraform plan *`. None for a program named by
// path, whose name says nothing about what it is.
function allowPattern(argv: string[]): string | undefined {
  if (!/^[\w.+-]+$/.test(argv[0])) return undefined;
  const first = argv[1] !== undefined && /^(-{1,2})?[A-Za-z][\w-]*$/.test(argv[1]) ? ` ${argv[1]}` : "";
  return `${argv[0]}${first} *`;
}

// ---- whole tool calls ----

const FORK_BOMB = /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/;
// A download piped into a shell, or into an interpreter that reads its program from stdin.
// `curl ... | python3 -c "..."` is not one: the download is the program's input.
const PIPE_TO_SHELL = /\b(curl|wget)\b[^|;&\n]*\|\s*(sudo\s+)?(env\s+)?(ba|z|da|k)?sh\b|\b(curl|wget)\b[^|;&\n]*\|\s*(python3?|node|perl|ruby)\s*(-\s*)?($|[|;&\n)])/;

function evaluateParsed(parsed: Parsed, scope: Scope, depth: number): Verdict {
  let verdict: Verdict = parsed.opaque ? classify("shell syntax the rules do not model") : ALLOW;
  // Relative paths are only trusted while the working directory is known.
  const local: Scope = { ...scope };
  const hasCd = parsed.cmds.some((c) => ["cd", "pushd", "popd"].includes(c.argv[0]));
  if (hasCd && parsed.grouped) local.cwd = undefined;
  // The patterns of the parts left to the model. A prompt offers one only when it covers them all.
  const patterns = new Set<string | undefined>(parsed.opaque ? [undefined] : []);
  for (const cmd of parsed.cmds) {
    const part = simple(cmd, local, depth);
    if (part.action === "classify") patterns.add(part.pattern);
    verdict = worst(verdict, part);
    if (verdict.action === "deny") return verdict;
    if (cmd.argv[0] === "cd" && local.cwd) {
      local.cwd = cmd.argv.length === 2 ? resolveWord(cmd.argv[1], local) : cmd.argv.length === 1 ? HOME : undefined;
    } else if (cmd.argv[0] === "pushd" || cmd.argv[0] === "popd") local.cwd = undefined;
  }
  return verdict.pattern && patterns.size > 1 ? { ...verdict, pattern: undefined } : verdict;
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
  // The write tool replaces the whole file with the agent's text; an edit keeps the file's origin.
  if (tool === "write") note(p, "authored", scope);
  return isLocal(p, scope) ? ALLOW : outside(`${tool} outside the working directory: ${target}`, p);
}

// read and grep tools: an ask for a credential file, undefined for every other path.
export function readVerdict(tool: string, target: string, scope: Scope): Verdict | undefined {
  const secret = secretIn(target.startsWith("@") ? target.slice(1) : target, scope, true);
  return secret ? ask(`${tool} of a credential file: ${target}`) : undefined;
}
