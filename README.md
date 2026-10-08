# pi-automode-classifier

An auto mode plugin for the [Pi](https://pi.dev) coding agent that uses a classifier model, [Jev](https://docs.typesafe.ai/api) (hosted) or [Kev](https://huggingface.co/jaredpalmer/kev-0.8b)/[Laya](https://huggingface.co/convaiinnovations/laya-typed-decisions) (running locally), to classify shell commands before they run.

It decides per tool call whether the call runs, needs a confirm prompt, or is blocked. Built-in rules decide most calls. The model checks the shell commands the rules don't know, and you get a prompt for the risky ones.

I built it because Pi runs every tool call without asking for approval, and I wanted something like Claude Code's auto mode. With Kev or Laya on CPU it works fully offline and doesn't use the GPU. With Jev the commands are sent to the provider, so that one is opt-in.

It is not a sandbox. It guards the agent's tool calls. It doesn't guard `!` commands you type, and extensions run with your user's permissions. Read [Pi's security docs](https://pi.dev/docs/latest/security) for real isolation.

## How it decides

1. **Rules** (`rules.ts`) parse the shell command, including `$(...)`, `bash -c` strings and `sudo`/`timeout`/`uv run` style wrappers, and give one of four verdicts:
   - **deny**: `rm -rf` of `/`, `$HOME` or a system directory, `mkfs`, `dd` to a disk, fork bombs. Blocked, no prompt.
   - **ask**: root (`sudo`), anything visible to others (`git push`, `gh pr create`, `npm publish`), sending data out (`curl -d`, `scp`, `nc`), `curl | sh`, deletes and writes outside the working directory, `git reset --hard`, service and package changes, and edits to this extension's own files.
   - **allow**: read-only commands, builds, tests, linters, local git work, and file changes inside the working directory or `/tmp`.
   - **classify**: everything else, for example `python scripts/deploy.py` or `kubectl delete ...`.
2. **The model** gets the commands marked classify. It answers one yes/no question, "is this command risky?", with a probability. Below `askAbove` (default 0.2) the command runs.
3. **You** get a confirm prompt for every ask verdict, for a model risk at or above `askAbove`, and when the model can't answer (server down, timeout, command longer than the model's context). The choices are `Allow once`, `Allow for this session` and `Block`. The model never blocks anything by itself.

Without a UI (print mode, most subagents) there is nobody to ask, so those calls are blocked and the agent is told why. Set `withoutUi` to `allow` if you'd rather let them run.

`write` and `edit` are allowed inside the working directory and ask outside it. Any tool with a string `command` input is treated like `bash`.

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
| `classifier` | see below | The expected model, the question sent to it, and extra questions |

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
- `deny`, `ask` and `classify` rules also match the command without wrappers and variables, so `terraform apply *` catches `TF_VAR_x=1 timeout 600 terraform apply`. An `allow` rule has to match the command exactly as written.
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

## Limits

- The model only sees the command and the working directory. It can't tell whether you asked for the action.
- Script files are never read. `bash deploy.sh` is judged on that command line alone.
- A command longer than the server's context always gets a prompt. A bigger context doesn't make long commands safe to check: Kev-0.8B scored a 3,700-character command with `rm -rf ~/Documents` as its last step at 0.15, and at 0.29 with the same step first. The rules don't have this problem, they parse the whole command at any length.
- `make`, `npm run`, `cargo test` and similar are allowed by rule and can run anything the project defines. Add a `classify` or `ask` rule for the targets you care about.
- Tools from other extensions without a `command` input are not checked.
- English commands and paths only were tested.

## Development

`node test.mjs` runs the rule, config and handler tests and needs no server. `node bench.mjs [askAbove] [endpoint | provider/model]` needs the server running, or `pi` installed for a provider. Both need Node 22.18 or newer, and neither executes any of the commands.

## License

MIT
