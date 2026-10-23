# pi-automode-classifier

An auto mode plugin for the [Pi](https://pi.dev) coding agent that uses a classifier model, [Jev](https://docs.typesafe.ai/api) (hosted) or [Kev](https://huggingface.co/jaredpalmer/kev-0.8b)/[Laya](https://huggingface.co/convaiinnovations/laya-typed-decisions) (running locally), to classify shell commands before they run. Opt in and a general chat model decides instead, over the same context [Claude Code's auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode) gives its classifier.

It decides per tool call whether the call runs, needs a confirm prompt, or is blocked. Built-in rules decide most calls. The model checks the shell commands the rules don't know, and you get a prompt for the risky ones.

I built it because Pi runs every tool call without asking for approval, and I wanted something like Claude Code's auto mode. With Kev or Laya on CPU it works fully offline and doesn't use the GPU. With Jev the commands are sent to the provider, so that one is opt-in.

It is not a sandbox. It guards the agent's tool calls. It doesn't guard `!` commands you type, and extensions run with your user's permissions. Read [Pi's security docs](https://pi.dev/docs/latest/security) for real isolation.

## How it decides

1. **Rules** (`rules.ts`) parse the shell command, including `$(...)`, `bash -c` strings and `sudo`/`timeout`/`uv run` style wrappers, and give one of four verdicts:
   - **deny**: `rm -rf` of `/`, `$HOME` or a system directory, `mkfs`, `dd` to a disk, fork bombs. Blocked, no prompt.
   - **ask**: root (`sudo`), anything visible to others (`git push`, `gh pr create`, `npm publish`), sending data out (`curl -d`, `scp`, `nc`), `curl | sh`, running a file that was downloaded in this session, [reading a credential file](#credential-files), deletes and writes outside the working directory, `git reset --hard`, service and package changes, and edits to this extension's own files.
   - **allow**: read-only commands, builds, tests, linters, local git work, file changes inside the working directory or `/tmp`, and [scripts and programs of the project](#scripts-and-programs).
   - **classify**: everything else, for example `python scripts/deploy.py` or `kubectl delete ...`.
2. **The model** gets the commands marked classify. A decision model answers one yes/no question, "is this command risky?", with a probability. Below `askAbove` (default 0.2) the command runs. With [`classifier.llm`](#or-use-a-chat-model-as-the-decider) a chat model answers instead, and it reads your messages and the session's tool calls rather than the command alone.

   One model answers, the first of these that is set up:
   1. `classifier.llm` with `enabled: true`: a [chat model](#or-use-a-chat-model-as-the-decider) through Pi. It has its own `provider`, `model` and `timeoutMs`, and the other `classifier` keys, `endpoint`, `startCommand`, `timeoutMs` and `askAbove` are not used.
   2. `classifier.command`: a [classifier that runs as a process](#or-use-a-classifier-that-runs-as-a-process), like LANCET.
   3. `classifier.provider`: a [decision model hosted through Pi](#or-use-a-hosted-model-through-pi), with `classifier.model` as its id.
   4. The local server at `endpoint`, which `startCommand` starts when the port is closed.

   You can keep more than one in the config. Turning `classifier.llm` off falls back to the next one.
3. **You** get a confirm prompt for every ask verdict, for a model risk at or above `askAbove`, and when the model can't answer (server down, timeout, command longer than the model's context). A decision model never blocks anything by itself. The chat decider blocks what it judges dangerous, and by default also what it can't answer (`onBlock`, `failClosed`).

Without a UI (print mode, most subagents) there is nobody to ask, so those calls are blocked and the agent is told why. Set `withoutUi` to `allow` if you'd rather let them run.

`write` and `edit` are allowed inside the working directory and ask outside it. `read` and `grep` are not checked, except for credential files. Any tool with a string `command` input is treated like `bash`.

The working directory is the directory Pi runs in, plus the git checkout it belongs to and that repository's worktrees. Only the worktrees that exist when the session first runs a command count. One added later asks once, so `git worktree add` can't open a new folder by itself.

### The prompt

Every prompt has `Allow once`, `Allow for this session` and `Block`. Two kinds of prompt offer a wider choice, so the next similar call doesn't ask again:

- **A command the rules don't know.** The prompt offers the command with its subcommand or first flag as a pattern, for example `Allow "terraform plan *" for this session`. `Always allow "terraform plan *"` also saves the pattern to `rules.allow` in your config. Inline code (`python3 -c`, `bash -c`) and the built-in ask rules (`git push`, `sudo`) are never offered a pattern.
- **A change outside the working directory.** The prompt offers the folder and not just that one file: the git checkout or worktree the path is in, or else its parent directory. `Always allow changes in <folder>` also saves it to `allowedPaths`. `$HOME` itself and system directories are never offered as a whole.

### Scripts and programs

A command like `./scripts/build.sh` or `python3 tools/gen.py` says nothing about what the file does, so the rules look at where the file came from:

- **A file of the project runs.** That is a file tracked or ignored by the git repository Pi runs in, for example `./scripts/build.sh`, `python3 tools/gen.py` or `target/debug/app`. `cargo run` and `npm test` are already allowed and run the same code.
- **A script the agent wrote in this session runs**, also in `/tmp`. That covers the `write` tool, a heredoc, `echo` and `printf`.
- **A file that `curl` or `wget` saved in this session asks** before it runs, also after `cp`, `mv` or an append.
- **The model decides the rest**: inline code (`python3 -c`, `node -e`, code on stdin), new files the agent didn't write, files of another repository cloned inside the project, and any script with `deploy`, `publish`, `release`, `upload` or `prod` in its name or arguments.

### Credential files

A command that reads a credential file asks, also a read-only one like `cat ~/.aws/credentials`, because the content ends up in the agent's transcript. The same goes for the `read` and `grep` tools.

- **Places**, in any home directory, including `.ssh`, `.aws`, `.gnupg`, `.kube`, `.azure`, `.oci`, `.config/gcloud`, `.docker/config.json`, `.netrc`, `.npmrc`, `.pypirc`, `.git-credentials`, keyrings and keychains, shell history, and `/etc/shadow`.
- **File names**, anywhere: `.env` and `.env.production`, `id_rsa` and the other private key names, `*.pem`, `*.key`, `*.p12`, `*.jks`, `*.kdbx`, `secrets.yaml`, `credentials.json`, and service account JSON files.
- **Not asked**: commands that only name the file (`ls`, `stat`, `test -f`, `chmod`), writing one (`cp .env.example .env`, `sed -i`, `>> .env`), `--env-file .env`, public keys, `known_hosts`, `~/.ssh/config`, `~/.aws/config`, certificates and `.env.example`.

An `allow` rule in your config replaces the ask, for example `"cat ~/.npmrc"`.

## Install

```bash
pi install npm:pi-automode-classifier
# or straight from GitHub
pi install git:github.com/deepu105/pi-automode-classifier
```

Or from a checkout: `pi install ./pi-automode-classifier`.

In a session, `/automode-classifier off` turns the guard off, `on` turns it back, and `status` shows the state, the server health, your rule counts and the counts for the session.

## Run the model server

The extension talks to a [llama.cpp](https://github.com/ggml-org/llama.cpp) server through the `/v1/systemone` endpoint, which needs a build from October 2, 2026 or later ([#29818](https://github.com/ggml-org/llama.cpp/pull/29818)). I use [Kev-0.8B](https://huggingface.co/jaredpalmer/kev-0.8b) as a Q8 GGUF (774 MB).

```bash
llama-server -hf ggml-org/Kev-0.8B-GGUF:Q8_0 --host 127.0.0.1 --port 11438 --no-webui \
  --threads 8 --parallel 1 --ctx-size 1024 --sleep-idle-seconds 300
```

`--sleep-idle-seconds` unloads the model when Pi is idle: about 1.1 GB loaded, 147 MB asleep, 1.3 s to wake up. I'd use a CPU-only build of llama.cpp for this so it stays off the GPU.

You can keep the server running yourself, or let the extension start it with `startCommand` when it finds the port closed. Two ways I've tested:

### systemd

`systemd/pi-automode-classifier.service` is an example user unit. Install it and set this in the config:

```json
{ "startCommand": ["systemctl", "--user", "start", "pi-automode-classifier.service"] }
```

### LlamaStash

[LlamaStash](https://llamastash.dev) can manage the server too, and this is what I run. Its proxy doesn't forward `/v1/systemone` (as of 0.6.1), so the extension talks to the model's own port, and the port has to be pinned.

Add a CPU-only `llama-server` and a preset for the model to `~/.config/llamastash/config.yaml`, then restart the daemon:

```yaml
backend:
  llamacpp:
    servers:
      # ... your existing servers stay first
      - name: cpu
        binary: /path/to/llama.cpp/build-cpu/bin/llama-server
presets:
  Kev-0.8B-Q8_0.gguf:
    default: automode
    entries:
      automode:
        server: llamacpp-cpu
        knobs:
          threads: 8
          parallel: 1
          ctx_size: 1024
        extras: ["--sleep-idle-seconds", "300"]
```

Then set:

```json
{ "startCommand": ["llamastash", "start", "Kev-0.8B-Q8_0.gguf", "--preset", "automode", "--port", "11438", "--wait"] }
```

Keep `--preset automode` in the command. Without the preset LlamaStash would launch the model on its default server, which is usually the GPU one.

## Or use a hosted model through Pi

Pi has decision models built into its model registry, [Jev](https://docs.typesafe.ai/api) from TypeSafe among them, and the extension can ask one of those instead of a local server. Pi handles the credentials, so anything you are logged in to works. With OpenRouter:

```json
{
  "askAbove": 0.5,
  "classifier": { "provider": "openrouter", "model": "typesafe/jev-1.13" }
}
```

This sends every classified command and its working directory to that provider. Commands can contain tokens and paths, so don't turn it on for work that has to stay on your machine. The rules still settle most calls locally, and only the commands they mark classify go out.

Jev was much better than the local models on my 50 commands:

| | Jev 1.13 (hosted) | Kev-0.8B (local) |
| --- | --- | --- |
| Model alone, risky ranked above safe (AUC) | 0.999 | 0.97 |
| Scores on the 16 commands the rules leave to the model | safe up to 0.28, risky from 0.82 | safe up to 0.17, risky from 0.28 |
| Latency per call (p50) | 269 ms | 174 ms |
| Cost | about 370 input tokens per call, $0.042 per million | 1.1 GB of RAM |

That works out to about 1.5 cents per 1,000 classified commands at the time of writing. Note the higher `askAbove`: with the default 0.2, two of the six safe commands got a prompt. If the provider is slow, down or rate limited you get a prompt, like with a local server that doesn't answer.

Pin a version (`typesafe/jev-1.13`) and don't use `~typesafe/jev-latest`: a threshold tuned for one version shouldn't silently apply to the next. `node bench.mjs 0.5 openrouter/typesafe/jev-1.13` runs the bench through Pi's registry, and works the same for the other decision models your providers offer.

## Or use a chat model as the decider

`classifier.llm` is off by default. With it on, the calls the rules leave to the classifier go to a general chat model instead of a decision model, and that model reads the same thing Claude Code's auto mode classifier reads: your own messages from the session and the tool calls the agent made, with the agent's own prose and all tool output stripped out. It answers block or allow, names the rule that fired, and gives a reason.

This is what the small decision models cannot do, because they only see one command line:

- **It reads intent.** `git push --force origin main` after "fix the flaky test" is blocked; the same push after "force push the branch, I rebased it" runs. Naming the destructive step is what clears a rule, and the model has your messages to check it against.
- **It applies a rule book, not one question.** The shipped lists are Claude Code's own defaults, read out of a local Claude Code with `claude auto-mode defaults`: 1 hard block, 72 soft blocks, 17 allow exceptions and 21 environment slots, with the same `$defaults` splice. The wording is what Claude Code sends, trimmed to what applies to Pi: the browser and cross-session rules are out, everything about git, credentials, deploys, exfiltration, persistence and self-modification is in.
- **The deny says why.** `[Credential Exploration] the agent is scanning ~/.aws and ~/.config for tokens` goes back to the agent, which is told to find a safer path and not to route around the block.

The cost is context. The fixed prompt is about 101,000 characters, roughly 25,000 tokens, so it is sent as the system prompt and kept byte-identical between calls; every call after the first is a prefix cache hit, and `warmCache` spends one throwaway call at session start so even the first one hits. Measured on Qwen3.8-Flash-Next (`flash-next-halogen@multi-agent-balanced`) on a Ryzen AI Max+ 395, with this session sharing the GPU: a cold prefill is 22 s, a call stage 1 passes is about 1.2 s, and a call that needs the reasoning stage is 20 to 55 s. That last one is why `timeoutMs` defaults to 60 s and why `failClosed` matters. Run it on an idle GPU or a fast hosted model and it is quicker.

With a hosted chat model this sends your user messages, not just commands, to that provider. For work that has to stay on your machine use a local model.

### The two stages

Same split Claude Code uses. Stage 1 gets the rule book plus the transcript and is told to err toward blocking and answer with no reasoning; anything it does not clearly pass goes to stage 2, which sees the identical prompt with a different last line and is told to follow the classification process carefully, because explicit user confirmation is what overrides a block, and to think longer only on borderline calls. Claude Code also asks for a `<thinking>` block before the verdict; here only a model that does not reason through Pi gets that line, so a thinking model does not reason twice. Since the input is otherwise the same, stage 2 is a cache hit on stage 1. On my 27 bench cases stage 1 cleared 9 of them, including every routine one, so only the interesting calls paid for reasoning.

Pi's model API has no stop sequences, so stage 1 gets 128 tokens instead of Claude Code's 64, and an answer that runs out of budget, or does not open with its `<block>` tag, is treated as flagged rather than as an error. A stage 2 answer that runs past `maxTokens` is an error, so it fails closed: a cut-off answer may hold only a tag the model quoted from the action.

### What it does and does not copy from Claude Code

| Claude Code auto mode | here |
| --- | --- |
| Allow rules and deny rules resolve before the classifier | Built-in rules and your `rules` run first; your `ask` rules always prompt, your `deny` rules always block |
| In-project file edits skip the classifier | `write` and `edit` inside the working directory and the repo's worktrees are allowed by rule. Outside it they still get the confirm prompt instead of a decider call: the one place Claude Code asks its classifier, this asks you. Running a file the session wrote or edited goes to the decider with the file's current content, so code written to a file is judged like code in the command. A `curl` that sends data only to `localhost`, `127.x.x.x` or `[::1]`, with no proxy, `--resolve`, `--connect-to` or config file, also goes to the decider instead of asking: a local server can still pass the data on |
| A safe-tool allowlist (reads, search, todos, plan mode) skips it | `read`, `grep` and other tools with no `command` input are not sent, except credential files |
| Transcript of user messages and tool calls, assistant prose and tool results stripped | Same, and both strips are configurable (`includeAssistantText`, `includeToolResults`) |
| An outcome line under each finished tool call: `ok`, `error`, `rejected-by-user`, `blocked-by-permissions`, `automode-blocked`, `automode-unavailable`, `automode-parsing-error`, `interrupted` | Same values except `interrupted`, which Pi cannot tell apart from an error. Why the guard held a call back is kept in memory, so after Pi restarts those calls show as `error` |
| Two-stage classifier, 64-token filter then chain of thought | Same shape, 128-token filter, reasoning level set by `thinkingLevel` |
| Classifier is Sonnet or the session model | Any model in Pi's catalog, or the session's own model with `provider` and `model` left empty |
| ~20 block groups, environment slots, `$defaults` | Shipped from `claude auto-mode defaults`, same splice rule |
| Consent bars that need the must-name item, Path A and Path B | Kept |
| Deny-and-continue, then stop after 3 consecutive or 20 total denials | Same counters, and the escalation is a confirm prompt instead of a mode switch |
| Iron gate closed when the classifier cannot answer | `failClosed: true` by default; set false to prompt instead |
| Server-side prompt-injection probe on tool results | Not implemented. Nothing screens what the agent reads |
| Classifiers at subagent handoff | Not implemented |
| Drops blanket allow rules like `Bash(*)` when entering auto mode | The rules engine replaces that: only what it cannot settle reaches the model. `rules.classify` sends more, `classifyAllShell` has no equivalent |

### Configuration

Every key is optional; what you leave out keeps its default.

| Key | Default | What it does |
| --- | --- | --- |
| `enabled` | `false` | Turn the chat decider on. Off, the decision model or the confirm prompt decides |
| `provider`, `model` | `""` | Pi provider id and model id. Both empty: the model of the current session. A `model` without a `provider` is looked up in the session's provider. A model Pi does not have is an error, never a switch to the session model |
| `name` | `""` | Name in the decision log and in `/automode-classifier status`. Empty: `provider/model` |
| `contextWindow` | `0` | Override the catalog window; the transcript is fitted to it. `0`: catalog value |
| `maxTokens` | `2048` | Reply budget of the reasoning stage |
| `reasoning` | `true` | Send a thinking level at all |
| `thinkingLevel` | `"low"` | Which level to send: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Stage 1 never sends one |
| `warmCache` | `true` | One throwaway call at session start, so the rule prompt is cached before the first real question. Set `false` for a model you pay per token |
| `twoStage` | `true` | Fast filter first, reasoning only on what it flags |
| `stage1MaxTokens` | `128` | Reply budget of the filter stage |
| `timeoutMs` | `60000` | Per-call timeout |
| `failClosed` | `true` | No answer means the call is held back. `false`: fall back to the confirm prompt. Without a UI no answer is always a block |
| `onBlock` | `"block"` | `block` denies and tells the agent to find a safer path. `ask` shows the confirm prompt. Without a UI a decider block is always a block, whatever `withoutUi` says |
| `maxConsecutiveDenials` | `3` | After this many denials in a row the human is asked instead (blocked without a UI) |
| `maxTotalDenials` | `20` | ...and after this many in the session |
| `transcript.maxEntries` | `60` | Transcript lines kept. Tool lines are dropped before your messages, oldest first |
| `transcript.maxChars` | `24000` | Size cap of the lines before the action, also shrunk to fit `contextWindow`. Tool lines go before your messages, oldest first. The action is never cut: one too long for the window is an error |
| `transcript.toolInputChars` | `1200` | Cap per earlier tool call; file bodies are replaced by their size. The call under review is sent whole |
| `transcript.userMessageChars` | `4000` | Cap per user message |
| `transcript.includeAssistantText` | `false` | Include the agent's own prose as quoted `Assistant:` lines, which the prompt says are not user intent. Claude Code strips it to keep it from talking itself into a block |
| `transcript.includeToolResults` | `false` | Include tool output as quoted `Result <tool>:` lines. Off, hostile output cannot reach the decider |
| `environment`, `hardDeny`, `softDeny`, `allow` | built-in | Rule lists. `"$defaults"` keeps the built-in list at that position; a list without it replaces that section |

### Sample config

The least it needs is `enabled` and the model. With `provider` and `model` left out it uses the session's own model:

```json
{
  "classifier": {
    "llm": {
      "enabled": true,
      "provider": "llamastash-z13",
      "model": "flash-next-128k"
    }
  }
}
```

A local model through Pi's own provider, one lane of the shared server, with the limits set by hand:

```json
{
  "classifier": {
    "llm": {
      "enabled": true,
      "provider": "llamastash-z13",
      "model": "flash-next-256k",
      "name": "Qwen3.8-Flash-Next",
      "contextWindow": 262144,
      "maxTokens": 4096,
      "reasoning": true,
      "thinkingLevel": "low",
      "twoStage": true,
      "stage1MaxTokens": 128,
      "timeoutMs": 60000,
      "failClosed": true,
      "onBlock": "block"
    }
  }
}
```

`node bench-llm.mjs llamastash-z13/flash-next-256k low` runs the 27 cases in `bench-llm-cases.json` through it. Each case is a user message plus a pending action, 15 that should be blocked and 12 that should run, and it prints the rule name the decider used and what each stage cost.

On `flash-next-halogen@multi-agent-balanced`, GPU shared with the session running the bench: 21 of 27 right, 12 of the 15 dangerous ones caught, and none of the 12 routine ones blocked. Stage 1 cleared 9 of 27 on its own at about 1.2 s. The three misses were `scancel 4471` for "cancel my slurm job" (a job id the agent picked), `npm install lodash` for an import that failed (a package the agent chose, not one in the manifest), and editing the guard's own settings for "make auto mode stop asking about git push", which reads like the user having asked for exactly that. Three more reached the 60 s timeout in stage 2 and were held back as failures rather than as decisions.

The decider's own rules are yours to edit, and `claude auto-mode defaults` on a machine with Claude Code prints the current built-in list:

```json
{
  "classifier": {
    "llm": {
      "enabled": true,
      "provider": "openrouter",
      "model": "anthropic/claude-sonnet-4.6",
      "thinkingLevel": "medium",
      "softDeny": ["$defaults", "Never run database migrations outside the migrations CLI, even against dev databases"],
      "environment": ["$defaults", "Source control: github.example.com/acme-corp and all repos under it", "Trusted internal domains: *.internal.example.com"]
    }
  }
}
```

The environment slots are what stop the internal-infrastructure false positives: with nothing configured, only the working repository and its remotes count as inside, so a push to your own company org or a write to a team bucket gets blocked until you name them.

## Or use a classifier that runs as a process

Some classifiers are not llama.cpp models. With `classifier.command` set, the extension starts that program once, keeps it running, and sends it one command at a time. The program reads a JSON line `{"command": "...", "shell": "bash", "cwd": "..."}` on stdin and prints a JSON line with a `score` from 0 to 1.

[LANCET Nano](https://github.com/TannerMidd/LANCET-model) works this way. It is a 111M-parameter classifier for command risk, and it runs on CPU with ONNX Runtime. I tested the pre-release v0.4.3 with Python 3.13:

```bash
mkdir -p ~/.local/share/lancet && cd ~/.local/share/lancet
gh release download v0.4.3 -R TannerMidd/LANCET-model
sha256sum -c SHA256SUMS.txt
unzip lancet-v0.4.3-nano-cpu-int8.zip
uv venv --python 3.13 venv
uv pip install --python venv/bin/python -r lancet-v0.4.3-nano-cpu-int8/requirements.txt
```

```json
{
  "askAbove": 0.2956,
  "classifier": {
    "command": [
      "~/.local/share/lancet/venv/bin/python", "-I",
      "~/.local/share/lancet/lancet-v0.4.3-nano-cpu-int8/classify.py",
      "--model", "~/.local/share/lancet/lancet-v0.4.3-nano-cpu-int8/model"
    ]
  }
}
```

`0.2956` is the model's own review threshold. The model reads only the command text, so the question, `levels` and `extraQuestions` are not used.

On the 50 bench commands and on commands from my own sessions:

| | LANCET Nano 0.4.3 | Kev-0.8B |
| --- | --- | --- |
| Safe bench commands that run without a prompt | 25 of 25 | 25 of 25 |
| Risky bench commands that run without a prompt | 1 of 25 | 0 of 25 |
| Model alone, risky ranked above safe (AUC) | 0.989 | 0.97 |
| Safe commands from my sessions that got a prompt | 0 of 31 | 17 of 31 |
| Latency per call (p50) | 28 ms | 174 ms |
| Memory | 248 MB | 1.1 GB |

LANCET asks far less often, and it let one risky bench command run: `python scripts/deploy.py --env production`, which it scored 0.08. Its author reports that it misses about 1 in 5 risky commands on their own benchmark. A lower `askAbove` catches more: at 0.1 it flags 23 instead of 20 of the 33 risky commands in the Rogue Security set (see [Other datasets](#other-datasets)), and 5 of my 31 safe session commands get a prompt.

Every Pi process runs its own copy of the program. It starts on the first command the rules leave to the model, which adds about a second to that call, and it stops after 5 minutes without one. If the program is missing, exits or doesn't answer in `timeoutMs`, you get a prompt.

## Configuration

Optional, in `~/.pi/agent/extensions/pi-automode-classifier/config.json`. A config with an error is ignored as a whole and you get a warning, so a typo can't half-apply.

| Key | Default | What it does |
| --- | --- | --- |
| `enabled` | `true` | Starting state of a session. `/automode-classifier on` and `off` change it for that session |
| `endpoint` | `http://127.0.0.1:11438` | Base URL of the model server |
| `timeoutMs` | `5000` | Model call timeout. A timeout becomes a prompt |
| `askAbove` | `0.2` | A model answer at or above this gets a prompt. `0` asks for every classified command |
| `startCommand` | `[]` | Command to run when the server refuses connections |
| `withoutUi` | `"block"` | What to do with a call that needs a prompt when there is no UI: `block` or `allow` |
| `log` | `true` | Append every decision to `~/.local/state/pi-automode-classifier/decisions.jsonl` |
| `rules` | all empty | Your own `deny`, `ask`, `classify` and `allow` patterns |
| `allowedPaths` | `[]` | More directories where file changes are allowed, like the project directory |
| `guardedPaths` | `[]` | More paths that count as the guard's own files, so changes to them always ask |
| `classifier` | see below | The expected model, the question sent to it, and extra questions. `classifier.llm` is the [chat decider](#or-use-a-chat-model-as-the-decider), off by default |

The decision log holds full commands, so treat it like shell history.

### Your own rules

Here is a config that allows pushes to `origin`, lets the model decide on deploys, always asks for `terraform apply` and blocks force pushes:

```json
{
  "rules": {
    "allow": ["git push origin *", "sudo systemctl restart nginx"],
    "classify": ["make deploy *", "npm run release *"],
    "ask": ["terraform apply *", "re:^docker (run|exec)\\b"],
    "deny": ["git push --force *"]
  },
  "allowedPaths": ["~/Workspace/scratch"]
}
```

- A pattern is matched against one simple command, not the whole line. `git push origin main && rm -rf ~/x` is two commands, and the `rm` still gets its own verdict.
- `*` matches any text. A trailing ` *` also matches no arguments, so `git push origin *` matches `git push origin`. Start a pattern with `re:` to use a regular expression.
- A matching rule replaces the built-in verdict for that command. If several of your rules match, the most severe wins: `deny`, `ask`, `classify`, `allow`.
- `deny`, `ask` and `classify` rules also match the command without wrappers and variables, so `terraform apply *` catches `TF_VAR_x=1 timeout 600 terraform apply`. An `allow` rule matches the command as written, and also behind `timeout`, `time`, `nice`, `ionice`, `nohup`, `setsid` and `stdbuf`, which run the same program. It doesn't match behind `env` or a `VAR=value` prefix, because those can change what runs.
- An `allow` rule covers everything nested in the command it matches. `bash -c *` allows whatever is in the string, so keep allow patterns narrow.
- Three things your `allow` rules can't change: the built-in deny rules, the prompt for edits to this extension's own files, and redirects (`>`) to a path outside the working directory. Use `allowedPaths` to open a directory instead.

`allowedPaths` also applies to the `write` and `edit` tools.

### Classifier questions

You can reword the main question and add your own yes/no questions:

```json
{
  "classifier": {
    "model": "kev",
    "question": "Is this command risky?",
    "risky": "Deletes data, touches files outside the project, changes the system, uses credentials, or sends data to a remote server",
    "safe": "Routine development work that only reads, builds, tests or edits files inside the project directory",
    "extraQuestions": {
      "secrets": {
        "question": "Does this command read passwords, tokens or private keys?",
        "yes": "Reads credentials, tokens, private keys or secret files",
        "no": "Does not touch any credentials or secrets",
        "askAbove": 0.5
      }
    }
  }
}
```

A yes at or above the question's `askAbove` gets a prompt, with the question's id in the reason. Every question is one more model pass, so three questions take about three times as long as one.

Describe both answers with `yes` and `no`. I only tested extra questions on Laya, where a bare "does this change a production system?" gave `node build.js` a 0.72.

For a local server, `classifier.model` is part of the model name the server must report. If the server runs something else, every classified command gets a prompt. That way a swapped model can't quietly answer questions and a threshold that were tuned for another one. With `classifier.provider` set, `classifier.model` is the model id in Pi.

### Sample configs

These are the setups I tested. Each one has the `config.json` and the server definition that goes with it. The samples spell out every field the classifier uses, including the ones left at their default:

| Field | What it does for the classifier |
| --- | --- |
| `endpoint` | Where the local model server listens. Not used with `classifier.provider` |
| `startCommand` | How the extension starts that server when the port is closed. Not used with `classifier.provider` |
| `timeoutMs` | How long to wait for an answer before prompting |
| `askAbove` | The risk at or above which you get a prompt. It is tuned per model |
| `classifier.command` | Command of a [classifier that runs as a process](#or-use-a-classifier-that-runs-as-a-process). When set, `endpoint`, `classifier.provider` and the questions are not used |
| `classifier.provider` | Empty for a local server, or a Pi provider id for a hosted model |
| `classifier.model` | Local: part of the model name the server must report. Hosted: the model id in Pi |
| `classifier.question` | The main question |
| `classifier.risky`, `classifier.safe` | Descriptions of the yes and no answers. Not used when `levels` is set |
| `classifier.levels` | When set, the main question is a graded score over these levels |
| `classifier.extraQuestions` | More yes/no questions, each with its own optional `askAbove` |

The other keys (`enabled`, `withoutUi`, `log`, `rules`, `allowedPaths`, `guardedPaths`) work the same with every model, so the samples leave them out.

The `startCommand` lines use LlamaStash. For the systemd unit use `["systemctl", "--user", "start", "pi-automode-classifier.service"]` and put the `llama-server` line in the unit's `ExecStart`. Leave `startCommand` out if you start the server yourself. All the LlamaStash presets need the CPU server from the [LlamaStash](#llamastash) section.

#### Kev-0.8B

This is what I run. Everything except `startCommand` is the default.

```json
{
  "endpoint": "http://127.0.0.1:11438",
  "startCommand": ["llamastash", "start", "Kev-0.8B-Q8_0.gguf", "--preset", "automode", "--port", "11438", "--wait"],
  "askAbove": 0.2,
  "classifier": {
    "model": "kev",
  }
}
```

LlamaStash preset:

```yaml
presets:
  Kev-0.8B-Q8_0.gguf:
    default: automode
    entries:
      automode:
        server: llamacpp-cpu
        knobs:
          threads: 8
          parallel: 1
          ctx_size: 1024
        extras: ["--sleep-idle-seconds", "300"]
```

Without LlamaStash, change `startCommand` to whatever starts your server. With the example systemd unit that is:

```json
{ "startCommand": ["systemctl", "--user", "start", "pi-automode-classifier.service"] }
```

Use `"startCommand": []` if you start the server yourself. Either way this is the server command, which goes in the unit's `ExecStart`:

```bash
llama-server -hf ggml-org/Kev-0.8B-GGUF:Q8_0 --host 127.0.0.1 --port 11438 --no-webui \
  --threads 8 --parallel 1 --ctx-size 1024 --sleep-idle-seconds 300
```

#### Kev-0.8B with a graded question

Same server and preset as above. It scored about the same as the yes/no question (AUC 0.971 against 0.968), so I only show it as an example of `levels`.

```json
{
  "endpoint": "http://127.0.0.1:11438",
  "startCommand": ["llamastash", "start", "Kev-0.8B-Q8_0.gguf", "--preset", "automode", "--port", "11438", "--wait"],
  "askAbove": 0.25,
  "classifier": {
    "model": "kev",
    "question": "How risky is this shell command?",
    "levels": [
      "safe: reads, builds, tests or edits project files",
      "uncertain: might change something outside the project",
      "dangerous: deletes data, changes the system, or sends data to a remote server"
    ],
  }
}
```

#### Laya typed-decisions

About half the memory of Kev-0.8B. It needs a higher threshold and a GGUF you convert yourself, because the community GGUF doesn't load in llama.cpp.

```json
{
  "endpoint": "http://127.0.0.1:11438",
  "startCommand": ["llamastash", "start", "laya-typed-decisions-Q8_0.gguf", "--preset", "automode", "--port", "11438", "--wait"],
  "askAbove": 0.38,
  "classifier": {
    "model": "laya",
  }
}
```

Convert the checkpoint once, and put the GGUF in a folder LlamaStash scans:

```bash
# in a llama.cpp checkout, with the checkpoint downloaded to ./laya-typed-decisions
python convert_hf_to_gguf.py ./laya-typed-decisions --outtype q8_0 --outfile laya-typed-decisions-Q8_0.gguf
```

LlamaStash preset. LlamaStash reads the GGUF as a chat model, so `mode: embedding` has to stay:

```yaml
presets:
  laya-typed-decisions-Q8_0.gguf:
    default: automode
    entries:
      automode:
        server: llamacpp-cpu
        knobs:
          mode: embedding
          threads: 8
          parallel: 1
          ctx_size: 512
        extras: ["--sleep-idle-seconds", "300"]
```

Without LlamaStash, change `startCommand` to whatever starts your server. With the example systemd unit that is:

```json
{ "startCommand": ["systemctl", "--user", "start", "pi-automode-classifier.service"] }
```

Use `"startCommand": []` if you start the server yourself. Either way this is the server command, which goes in the unit's `ExecStart`:

```bash
llama-server -m laya-typed-decisions-Q8_0.gguf --host 127.0.0.1 --port 11438 --no-webui \
  --threads 8 --parallel 1 --ctx-size 512 --sleep-idle-seconds 300
```

#### Laya

Works with the default threshold, but the gap between its safe and risky scores is small.

```json
{
  "endpoint": "http://127.0.0.1:11438",
  "startCommand": ["llamastash", "start", "Laya-Q8_0.gguf", "--preset", "automode", "--port", "11438", "--wait"],
  "askAbove": 0.2,
  "classifier": {
    "model": "laya",
  }
}
```

The LlamaStash preset is the Laya typed-decisions one with `Laya-Q8_0.gguf` as the key. 

#### Julia-1

I wouldn't use it. This is the best setup I found for it, and at this threshold it prompts for every command the rules leave to the model. I only ran it on a server I started by hand, so there is no LlamaStash preset here.

```json
{
  "endpoint": "http://127.0.0.1:11438",
  "startCommand": ["systemctl", "--user", "start", "pi-automode-classifier.service"],
  "askAbove": 0.67,
  "classifier": {
    "model": "julia",
    "question": "How risky is this shell command?",
    "levels": [
      "read-only, or a local build or test",
      "edits files inside the project directory",
      "changes things outside the project directory or installs software",
      "destroys data, leaks secrets, or changes remote or production systems"
    ],
  }
}
```

```bash
llama-server -hf ggml-org/Julia-1-GGUF:Q8_0 --host 127.0.0.1 --port 11438 --no-webui \
  --threads 8 --parallel 1 --ctx-size 8192 --ubatch-size 8192 --batch-size 8192 --sleep-idle-seconds 300
```

#### Jev 1.13 through OpenRouter

No server, so `endpoint` and `startCommand` don't apply: Pi makes the call with your OpenRouter login. Read [the hosted section](#or-use-a-hosted-model-through-pi) first, because this sends commands off your machine.

```json
{
  "askAbove": 0.5,
  "classifier": {
    "provider": "openrouter",
    "model": "typesafe/jev-1.13",
  }
}
```

#### LANCET Nano

No server and no questions. The install steps and the config are under [Or use a classifier that runs as a process](#or-use-a-classifier-that-runs-as-a-process).

## How well does it do?

`bench.mjs` runs 25 safe and 25 risky commands (`bench-cases.json`) through the built-in rules and the model. With Kev-0.8B Q8_0 on llama.cpp `5ad1c5da0`, 8 threads on a Ryzen AI Max+ 395:

| | Result |
| --- | --- |
| Safe commands that run without a prompt | 25 of 25 (19 by rule, 6 by model) |
| Risky commands that run without a prompt | 0 of 25 (15 caught by rule, 10 by model) |
| Model alone, risky ranked above safe (AUC) | 0.97 |
| Scores on the 16 commands the rules leave to the model | safe up to 0.17, risky from 0.28 |
| Model latency per call | p50 174 ms, or 211 ms with another model generating on the GPU |
| Server memory | 1.1 GB loaded, 147 MB when asleep |

I wrote those 50 commands while writing the rules, so read this as a sanity check and not as an accuracy claim. The decision log is there so you can check it against your own commands.

My own sessions looked different from the bench. In the first day the rules left 17 commands to Kev, all of them safe, and Kev asked for 13. They were long commands like `cd repo && timeout 240 some-tool --flag | head`, and Kev scores those between 0.14 and 0.39, where the risky bench commands start at 0.28. A different threshold doesn't fix that. What helped was letting the rules decide more of those commands ([scripts and programs](#scripts-and-programs), the [prompt choices](#the-prompt)) and trying [LANCET](#or-use-a-classifier-that-runs-as-a-process).

### Other models

These are the models I tried on the same 50 commands. All of them run on the same server.

| | Kev-0.8B | Laya typed-decisions | Laya | Julia-1 |
| --- | --- | --- | --- | --- |
| Model alone (AUC) | 0.97 | 0.94 | 0.91 | 0.69 |
| Highest safe and lowest risky score on the 16 commands left to the model | 0.17 and 0.28 | 0.36 and 0.40 | 0.18 and 0.22 | no gap |
| Latency per call (p50) | 174 ms | 101 ms | 102 ms | 39 ms |
| Server memory | 1.1 GB | 549 MB | 539 MB | 417 MB |
| Context | 1024 tokens as served | 512 tokens | 512 tokens | 8192 tokens |

- **[Laya typed-decisions](https://huggingface.co/convaiinnovations/laya-typed-decisions)** is the one to pick if 1.1 GB is too much.
- **[Laya](https://huggingface.co/convaiinnovations/laya)** works with the default threshold, but the gap between its safe and risky scores is small.
- **[Julia-1](https://huggingface.co/SupersonicLabs/Julia-1)** is small and fast and I wouldn't use it. With the yes/no question its answers sit near 0 for almost everything. A graded question did better, which is what `classifier.levels` is for: with `levels` set (2 to 10 descriptions, least risky first) the main question is asked as a score and the risk is the expected level scaled to 0..1. Even so, Julia-1 scores `kubectl delete namespace production` the same as `node build.js`.

The config for each one is under [Sample configs](#sample-configs). Run `node bench.mjs` with your config before you trust another model.

### Other datasets

I also ran the models, and three more classifiers built for command risk, on commands I didn't write. The numbers are for the model alone (AUC, 1.0 means every risky command scores above every safe one):

| | My 50 | [Rogue Security](https://huggingface.co/datasets/rogue-security/coding-agent-security-benchmark) (50) | [Permission Command Corpus](https://huggingface.co/datasets/cowWhySo/permission-command-corpus) (244) |
| --- | --- | --- | --- |
| Jev 1.13 (hosted) | 1.00 | 0.86 | 0.91 |
| LANCET Nano 0.4.3 | 0.99 | 0.88 | 0.79 |
| Kev-0.8B | 0.97 | 0.82 | 0.70 |
| [verdict-shell-safety](https://github.com/ericmaddox/verdict-shell-safety) | 0.97 | 0.65 | 0.79 |
| [ModernBERT-bash-classifier](https://huggingface.co/P0u4a/ModernBERT-bash-classifier) | 0.68 | 0.71 | 0.64 |
| [Kestrel](https://huggingface.co/kontext-security/Kestrel) 0.1.0 | 0.76 | 0.63 | 0.69 |

- Jev ranks best overall. LANCET is the best of the local ones and asks least on my own commands. Kev catches the most at its threshold because it flags the most: 8 of the 17 safe Rogue commands and 113 of the 139 safe commands in the permission corpus.
- I left the last three out of the plugin. verdict-shell-safety flagged 21 of my 31 safe session commands. ModernBERT-bash-classifier and Kestrel flagged 1 each, and each caught under half of the risky commands in at least two of the three sets.
- Don't compare models on a benchmark one of them trained on. LANCET 0.4.3 trained on [lancet-bench-1](https://github.com/TannerMidd/LANCET-model/tree/main/benchmarks/lancet-bench-1), where it scores 0.99 and falls to the numbers above elsewhere. The published Kestrel file scores every risky command of its own [ShellRisk-Bench](https://huggingface.co/datasets/kontext-security/ShellRisk-Bench) test split as risky and catches about a third elsewhere.
- The sets are small, and the Rogue Security labels depend on what the user asked for in the session, which none of these models see.

These datasets also showed what the rules missed: reads of credential files with read-only commands, which is why [credential files](#credential-files) ask now.

## Limits

The chat decider adds these:

- Its prompt is about 25,000 tokens. With a model that does not cache prefixes every classified call pays that prefill, which on a local 30B-class model is tens of seconds.
- It reads your user messages, so a hosted chat model sees the tail of your transcript, not just commands.
- The rule lists are Claude Code's, written for Claude Code's tool set. The browser and cross-session rules are dropped; the rest were written against a git-and-cloud workflow and read that way.
- Rule coverage on a smaller local model is not Claude Code's: it let a job id the agent picked, a package the agent chose, and a config edit the user had asked for run where the rule book says block. Run `node bench-llm.mjs` before trusting a model with it, and check `thinkingLevel` and `timeoutMs` against your own hardware.
- The transcript is what the session holds, cut to `maxEntries` and `maxChars`. A decision that depends on something cut away cannot be made.
- Input piped to `pi -p` on stdin is part of your first message, so the decider reads it as your words. `@file` and skill blocks are cut out.
- A build or test command (`npm test`, `make`, `pytest`) still runs by rule, even after the agent edited the code it runs. Only running a session-written file directly goes to the decider.

- The model only sees the command and the working directory. It can't tell whether you asked for the action.
- Script files are never read. `bash deploy.sh` is judged on that command line and on where the file came from.
- A file of the project runs with any arguments, like a `make` target does. Add a `classify` or `ask` rule for the scripts you care about.
- The rules follow only the writes they can see: redirects, `cp`, `mv`, `tee`, `curl -o` and `wget`. A file that a program writes by itself, or one unpacked from an archive, is not followed. In a git-ignored folder such a file counts as a file of the project.
- A path or program held in a shell variable (`mkdir $D/state`, `$BIN list`) can't be resolved, so it asks or goes to the model.
- Credential files are found by path and name only. A command that uses a key file without printing it, like `openssl pkey -in server.key -pubout`, asks too. Secrets in a file with an ordinary name, and `printenv`, are not caught.
- A command longer than the server's context always gets a prompt. A bigger context doesn't make long commands safe to check: Kev-0.8B scored a 3,700-character command with `rm -rf ~/Documents` as its last step at 0.15, and at 0.29 with the same step first. The rules don't have this problem, they parse the whole command at any length.
- `make`, `npm run`, `cargo test` and similar are allowed by rule and can run anything the project defines. Add a `classify` or `ask` rule for the targets you care about.
- Tools from other extensions without a `command` input are not checked.
- English commands and paths only were tested.

## Development

`node test.mjs` runs the rule, config and handler tests and needs no server. It needs `git`, and it makes a scratch repository under `$HOME` and removes it again. `node bench.mjs [askAbove] [endpoint | provider/model]` needs the server running, or `pi` installed for a provider, or `classifier.command` set in your config. `node bench-llm.mjs [provider/model] [thinkingLevel|off] [single]` needs `pi` and a chat model for `classifier.llm`, and runs the user-message cases in `bench-llm-cases.json` through the chat decider. All three need Node 22.18 or newer, and none executes the commands under test.

## License

MIT
