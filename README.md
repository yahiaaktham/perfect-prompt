# perfect-prompt

A Claude Code mod that makes your first prompt complete before the main model sees it.

You type a task the way you always do. A cheap model checks whether anything is missing. If it is, you get a few quick questions, one dialog each, grounded in your own notes and the project you are in. Your request then comes back rewritten in your prompt box: task, why, context, constraints, what done looks like, how to verify. You read it, change what you like, and press Enter. After the task, the mod looks at how it went and remembers what your prompt lacked, so it asks about that first next time.

Why: one complete prompt beats a long back-and-forth. Laban et al. (2025, [arXiv 2505.06120](https://arxiv.org/abs/2505.06120)) measured a 39% average drop in quality when the same information arrives over several turns instead of one. A separate cheap "should we ask?" step recovers almost all of it (Edwards and Schuster 2026, [arXiv 2603.26233](https://arxiv.org/abs/2603.26233)).

## Install

```bash
claude plugin marketplace add yahiaaktham/perfect-prompt
claude plugin install perfect-prompt@perfect-prompt
```

Then restart Claude Code or run `/reload-plugins`. Needs Claude Code 2.1.287 or newer with mods on (the default). No other dependencies.

Update later with:

```bash
claude plugin marketplace update perfect-prompt
claude plugin update perfect-prompt@perfect-prompt
```

## How to use it

1. Type your request in the chat as you always do. Nothing else to learn.
2. Short messages, replies like "ok", slash commands and clear requests go straight through.
3. When you start a new task and details are missing, a dialog asks whether to go through a few quick questions. Say yes and the questions come one at a time, each with buttons and a free-text option; say "No, send as typed" to skip.
4. One question asks whether to search the web for best practices, research and GitHub repos. Say yes when the task is new to you. The search never runs on its own unless you set `webSearch` to `auto`.
5. Your request comes back rewritten into your prompt box. Nothing is sent yet.
6. Read it, change what you like, press Enter. The task runs in the same chat.
7. When you start your next task, the mod looks back at how the last one went and saves a lesson about what your prompt lacked.

A band above the prompt box shows what happened to your last prompt ("clear, sent as typed", "underspecified: review the prompt in your box") and the cheap-model tokens used this session, with Off and Hide buttons.

### Shortcuts

| You type | What happens |
|---|---|
| `>> your text` | sends the prompt raw, no questions |
| `/pp your text` | enhances that text on demand, even a short one |
| `/pp off`, `/pp on` | pause and resume for this session |
| `/pp lessons` | lists what it has learned about your prompts |
| `/pp forget 3` | drops lesson 3 |
| `/pp reflect` | learns from the last enhanced task right now |
| `/pp spec` | writes the assembled prompt to `SPEC-perfect-prompt.md` so you can start a fresh session with it |
| `/pp` or `/pp status` | shows status, settings in effect and token use |

## Settings

Open `/config` in Claude Code and look for perfect-prompt, or run `claude plugin configure perfect-prompt@perfect-prompt`.

| Setting | Default | Meaning |
|---|---|---|
| `mode` | `review` | `review`: the assembled prompt lands in your box and you press Enter. `auto`: it is sent at once |
| `model` | `haiku` | the cheap model for the gate, questions, assembly and reflection; an alias or a full model id |
| `vaultPath` | `~/.claude` | your notes folder (see below); `~` is your home folder |
| `rulesFile` | `CLAUDE.md` | file inside the notes folder read as your standing rules (head only) |
| `memoryIndex` | `MEMORY.md` | file inside the notes folder that indexes your memory notes, one line per file |
| `webSearch` | `ask` | `ask`: one of the questions offers a web search. `auto`: always search. `off`: never |
| `maxQuestions` | `2` | content questions per round, 1 to 3, each its own dialog |
| `minWords` | `12` | prompts with fewer words are never checked |

## The notes folder and what happens without one

The mod can ground its questions in your own standing rules and memory notes. It looks for them in one folder, `vaultPath`:

- `rulesFile` (default `CLAUDE.md`) is read as your standing rules. The first 3,500 characters go to the question drafter and the assembler, so your rules shape the questions and the constraints section.
- `memoryIndex` (default `MEMORY.md`) is a markdown list with one line per memory note: `- [Title](file.md) - one-line summary`. The cheap model picks up to 6 notes that matter for the task; they are read from the same folder as the index and travel with the final prompt as hidden context.
- After a reflection, the lessons are appended to `perfect-prompt-lessons.md` in that folder, one dated bullet each, append-only. This file is the human-readable copy; the mod keeps its own copy in its store.

Both file settings take a path relative to the notes folder or an absolute path, so an Obsidian vault with its own layout works: set `vaultPath` to the vault and point `rulesFile` and `memoryIndex` at the files inside it.

With the default `vaultPath` of `~/.claude`, the rules file is your global `CLAUDE.md` (the one Claude Code already loads for you), and there is usually no `MEMORY.md`, so no memory notes are picked.

**Without a notes folder nothing breaks.** Every read is optional. A missing folder, a missing rules file or a missing index is skipped without a message, and the mod falls back to the project you are working in: its `CLAUDE.md`, the head of its `README.md`, the top-level file names and `git status`. The questions are then grounded in the project alone. Lessons still go to the mod's store, and `/pp lessons` still lists them.

## What it reads and writes

- Reads, never edits: the rules file and memory index above with the picked notes; the project's `CLAUDE.md`, `README.md`, top-level file names and `git status`.
- Writes: its own store (a JSON file under your Claude Code config folder), `perfect-prompt-lessons.md` in the notes folder after a reflection, and `SPEC-perfect-prompt.md` in the project only when you run `/pp spec`. Nothing else.
- Web search runs only when you say yes (or when `webSearch` is `auto`), through Claude Code's own WebSearch tool, so its permission rules apply.
- Prompts that look like they carry a secret (API keys, private keys, `password=`) are never sent to the cheap model and pass through unchanged.

## Cost

A checked prompt costs one short cheap-model call. An enhanced prompt costs about four (pick notes, draft questions, assemble, and later reflect) plus one per web search summary: roughly 20k to 40k input tokens on the cheap model, on your own Claude usage. `/pp` shows the running total for the session.

## Rules it follows

- Fails open: on any error your prompt goes through unchanged, and the band says so.
- In `review` mode nothing is sent without your Enter.
- Lessons are append-only with repeat counts, never rewritten whole, and you can forget any of them.
- The cheap model drafts; you decide.

## Demo

See [docs/demo.md](docs/demo.md) for a step-by-step walk-through with the dialogs and the assembled prompt.

## Develop

```bash
git clone https://github.com/yahiaaktham/perfect-prompt
cd perfect-prompt
claude plugin validate plugins/perfect-prompt
claude plugin test plugins/perfect-prompt
```

The plugin lives in `plugins/perfect-prompt`: `.claude-plugin/plugin.json` (settings), `hooks/register.tsx` (the five hooks and the pipeline), `hooks/register.test.tsx` (mocked-engine tests), `types/index.d.ts` (session state). The repo root is a one-plugin marketplace (`.claude-plugin/marketplace.json`).

To try a change locally without a marketplace, add the folder as a local marketplace:

```bash
claude plugin marketplace add /path/to/perfect-prompt
claude plugin install perfect-prompt@perfect-prompt
```

## License

MIT, see [LICENSE](LICENSE).
