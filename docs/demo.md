# Demo: one underspecified prompt, start to finish

Setup used here: a fresh Claude Code profile with only this plugin installed, a project folder holding a single `README.md`, no notes folder of any kind. So the mod has nothing but the project to work from.

## 1. Check that it is on

Type:

```
/pp status
```

Output from the run described above:

```
perfect-prompt: perfect-prompt on · mode review · model haiku · web ask · 2 question(s) per round
notes folder C:/Users/<you>/.claude · rules CLAUDE.md · memory index MEMORY.md · lessons perfect-prompt-lessons.md
0 prompts enhanced in all · 0 lessons · 0 cheap-model tokens this session
no enhanced prompt yet
Usage: type normally (long new tasks get questions) · >> sends raw · /pp <text> enhances that text · /pp off | on | lessons | forget <n> | reflect | spec
```

## 2. Type a vague task

```
write me a script that organises my downloads folder so it stays tidy without me doing anything
```

The band above the prompt box flips to `perfect-prompt · a few questions first`, and a toast says the same. The gate judged the message UNDERSPECIFIED: a new deliverable with no word on what done looks like, which files, or how to check it.

## 3. The dialogs, one at a time

Each dialog is a normal Claude Code question box with buttons and a free-text field. What you see depends on the task; the shape is always this:

1. **Perfect** `perfect-prompt: your task looks underspecified. Answer a few quick questions first?`
   `Yes, ask me` / `No, send as typed`
2. **Why** `What is the script for?`
   `Daily tidy-up` / `One-off cleanup` / `Prepare for a backup` (plus free text)
3. **Done** `What does done look like?`
   `Files sorted into folders by type` / `Sorted by month` / `Old files archived` (multi-select)
4. **Web search** `Search the web for best practices, research and GitHub repos first?`
   `Yes, search` / `No, skip it`

Press Escape on any dialog and the original text is sent as typed.

## 4. The assembled prompt lands in your box

Nothing is sent. The prompt box now holds something like this, with a one-line marker on top that the mod strips before the model sees it:

```markdown
# Task
Write a script that organises my Downloads folder by file type and month so it stays tidy on its own.

## Why
A daily tidy-up: I never want to sort Downloads by hand again.

## Context
Project folder: tidy-downloads (README.md only, no code yet). Target folder: ~/Downloads.

## Constraints and rules
- Never delete files; move only.
- Leave files that are still downloading alone.
- Standard library only, no admin rights.

## What done looks like
- One script in the project folder with a dry-run mode that lists moves without doing them.
- Files sorted into folders by type, then by month.

## Verification
Run the dry-run against a folder of sample files and show the planned moves.

## Decisions already made
- The script runs daily.
- Sort by type, then by month.
```

Edit anything, then press Enter. The band says `enhanced prompt sent`.

## 5. After the task

When you type your next long task, or run `/pp reflect`, the mod reads how the task went and saves at most two lessons about what the first prompt lacked, for example:

```
perfect-prompt: 1 lesson saved
new: Say whether the script should run on a schedule or by hand
fine
```

`/pp lessons` lists them with repeat counts. `/pp forget 1` drops one.

## Shortcuts seen in the demo

- `>> text` sends raw with no questions.
- `/pp text` forces the questions for a short prompt.
- `/pp spec` writes the assembled prompt to `SPEC-perfect-prompt.md` for a fresh session.

## Notes

- Section 1 is the exact output of a run in the setup described at the top. Sections 3 to 5 show the shape of the dialogs and the prompt; the words the cheap model picks differ from run to run.
- With a notes folder set in `vaultPath`, the dialogs skip what your rules and memory notes already answer, and the constraints section quotes them. See the README for the fallback rules.
