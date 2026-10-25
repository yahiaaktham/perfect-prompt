import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Band, Pending } from '../types'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLUGIN = 'perfect-prompt'
/** First line of an assembled prompt in review mode; stripped before it reaches the model. */
const MARKER = '<!-- perfect-prompt:v1 -->'
/** Origins that are a person typing. */
const HUMAN = new Set(['composer', 'bridge'])
const TRIVIAL = /^(ok|okay|yes|no|y|n|sure|go|go ahead|continue|proceed|thanks|thank you|done|next|stop|wait|hi|hello)[.!]?$/i
const SECRET = /(sk-[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{10,}|AKIA[A-Z0-9]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY|password\s*[:=]\s*\S+)/i
const MAX_LESSONS = 60
const MAX_FACT_CHARS = 3000
const MAX_FACTS = 6
const MAX_WEB_CHARS = 12000
const CLASSIFY_TIMEOUT = 20000
const MODEL_TIMEOUT = 90000

type Lesson = { id: string; text: string; taskType: string; count: number; firstAt: number; lastAt: number }
type LastEnhanced = {
  at: number
  sessionId: string
  original: string
  assembled: string
  verdict: string
  turns: number
  reflected: boolean
}
type Question = { question: string; header: string; options: { label: string; description?: string }[]; multiSelect: boolean }
type Draft = { questions: Question[]; assumptions: string[]; searchQueries: string[] }
type LocalContext = { brief: string; facts: string; project: string }

type Options = {
  mode: 'review' | 'auto'
  model: string
  vaultPath: string
  rulesFile: string
  memoryIndex: string
  webSearch: 'ask' | 'auto' | 'off'
  maxQuestions: number
  minWords: number
}

/** Name of the lessons file the mod appends to inside the notes folder (the store is the primary copy). */
const LESSONS_FILE = 'perfect-prompt-lessons.md'

const band = atom({ plugin: 'perfect-prompt', key: 'band' } as const, null)
const isOff = atom({ plugin: 'perfect-prompt', key: 'isOff' } as const, false)
const isHidden = atom({ plugin: 'perfect-prompt', key: 'isHidden' } as const, false)
const pending = atom({ plugin: 'perfect-prompt', key: 'pending' } as const, null)

let opts: Options = { mode: 'review', model: 'haiku', vaultPath: '~/.claude', rulesFile: 'CLAUDE.md', memoryIndex: 'MEMORY.md', webSearch: 'ask', maxQuestions: 2, minWords: 12 }
let homeDir: string | undefined
let sessionTokens = 0

// ---------------------------------------------------------------------------
// Small pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export function wordCount(s: string) {
  return s.trim().split(/\s+/).filter(Boolean).length
}

export function isTrivial(s: string) {
  return TRIVIAL.test(s.trim())
}

export function looksSecret(s: string) {
  return SECRET.test(s)
}

/** Pulls the first JSON object or array out of a model reply, fences and prose around it ignored. */
export function parseJson<T>(text: string): T | undefined {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  const starts = [cleaned.indexOf('{'), cleaned.indexOf('[')].filter(i => i >= 0)
  if (starts.length === 0) return undefined
  const start = Math.min(...starts)
  const endChar = cleaned[start] === '{' ? '}' : ']'
  const end = cleaned.lastIndexOf(endChar)
  if (end <= start) return undefined
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as T
  } catch {
    return undefined
  }
}

function normalize(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Word-set overlap, 0..1; two lessons above 0.6 are the same lesson. */
export function similarity(a: string, b: string) {
  const A = new Set(normalize(a).split(' ').filter(w => w.length > 2))
  const B = new Set(normalize(b).split(' ').filter(w => w.length > 2))
  if (A.size === 0 || B.size === 0) return 0
  let both = 0
  for (const w of A) if (B.has(w)) both += 1
  return both / (A.size + B.size - both)
}

/** Merges a new lesson into the list: a near-duplicate gains a count, a new one is appended, the list is capped. */
export function mergeLesson(list: Lesson[], text: string, taskType: string, now: number): { list: Lesson[]; isNew: boolean } {
  const hit = list.find(l => similarity(l.text, text) >= 0.6)
  if (hit) {
    hit.count += 1
    hit.lastAt = now
    return { list, isNew: false }
  }
  const lesson: Lesson = { id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, text, taskType, count: 1, firstAt: now, lastAt: now }
  const next = [...list, lesson]
  if (next.length > MAX_LESSONS) next.sort((x, y) => y.count - x.count || y.lastAt - x.lastAt).splice(MAX_LESSONS)
  return { list: next, isNew: true }
}

function clip(s: string, n: number) {
  return s.length <= n ? s : `${s.slice(0, n)}\n[... ${s.length - n} more characters cut]`
}

function dateOf(ms: number) {
  return new Date(ms).toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// Engine helpers
// ---------------------------------------------------------------------------

async function complete($: EngineInterface, system: string, prompt: string, maxTokens: number, timeoutMs = MODEL_TIMEOUT) {
  const r = await $.model.complete({ model: opts.model, system, prompt, maxTokens, timeoutMs })
  sessionTokens += r.usage.input_tokens + r.usage.output_tokens + (r.usage.cache_read_input_tokens ?? 0) + (r.usage.cache_creation_input_tokens ?? 0)
  return r.isAnswered ? r.text : undefined
}

async function home($: EngineInterface) {
  if (homeDir) return homeDir
  try {
    const r = await $.process.run(['powershell', '-NoProfile', '-Command', 'Write-Output $env:USERPROFILE'], { timeoutMs: 10000 })
    const out = r.stdout.trim()
    if (r.exitCode === 0 && out) homeDir = out.replace(/\\/g, '/')
  } catch {
    // not Windows, or no PowerShell
  }
  if (!homeDir) {
    try {
      const r = await $.process.run(['sh', '-c', 'echo $HOME'], { timeoutMs: 10000 })
      if (r.exitCode === 0 && r.stdout.trim()) homeDir = r.stdout.trim()
    } catch {
      // leave undefined
    }
  }
  return homeDir
}

/** Expands a leading ~ to the home folder and turns backslashes into slashes. */
async function expand($: EngineInterface, raw: string) {
  const p = raw.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!p.startsWith('~')) return p
  const h = await home($)
  return h ? `${h}${p.slice(1)}` : p
}

/** The notes folder from settings (`vaultPath`), `~` expanded. It may not exist; every read of it is optional. */
async function vaultPath($: EngineInterface) {
  return expand($, opts.vaultPath)
}

/** A file setting: absolute paths (or ~) stand alone, anything else is relative to the notes folder. */
async function resolveIn($: EngineInterface, file: string) {
  const f = file.replace(/\\/g, '/')
  if (f.startsWith('~') || f.startsWith('/') || /^[A-Za-z]:\//.test(f)) return expand($, f)
  return `${await vaultPath($)}/${f}`
}

async function readIf($: EngineInterface, path: string, max: number) {
  try {
    if (!(await $.fs.exists(path))) return ''
    return clip(await $.fs.read(path), max)
  } catch {
    return ''
  }
}

async function lessons($: EngineInterface): Promise<Lesson[]> {
  const v = await $.store.get('lessons')
  return Array.isArray(v) ? (v as Lesson[]) : []
}

async function lastEnhanced($: EngineInterface): Promise<LastEnhanced | undefined> {
  const v = await $.store.get('lastEnhanced')
  return v && typeof v === 'object' ? (v as LastEnhanced) : undefined
}

async function setBand($: EngineInterface, verdict: string) {
  const b: Band = { verdict, tokens: sessionTokens, at: await $.clock.now() }
  await update($, band, () => b)
}

// ---------------------------------------------------------------------------
// Step 1: the gate
// ---------------------------------------------------------------------------

const GATE_SYSTEM = `You classify one message a user typed into a coding/knowledge-work assistant (Claude Code).
Answer with exactly one label and nothing else: UNDERSPECIFIED, CLEAR or FOLLOWUP.

Step 1, read the message on its own, as if it were the first thing typed in a fresh session.
- It asks for a new deliverable or action (make, write, build, set up, organise, find, fix, summarise, plan...) and leaves out details the assistant would have to guess or ask about (what done looks like, scope, which files or data, constraints, how to verify): UNDERSPECIFIED.
- It asks for a new deliverable or action and gives enough to start: CLEAR.
- Decide here whenever the message stands on its own. A long session or an earlier topic does not make a new task a follow-up.

Step 2, only when the message cannot stand on its own: an answer ("yes", "the second one", "no, use pnpm"), a correction, a pronoun-led continuation ("do that for the other file too", "same for the rest"), a short question about what was just said. Then look at the previous assistant reply, and if the message answers or continues it: FOLLOWUP.`

async function classifyPrompt($: EngineInterface, text: string): Promise<'UNDERSPECIFIED' | 'CLEAR' | 'FOLLOWUP'> {
  let previous = ''
  try {
    const msgs = await $.session.messages()
    const last = [...msgs].reverse().find(m => m.role === 'assistant' && m.text.trim() !== '')
    if (last) previous = clip(last.text, 400)
  } catch {
    // no transcript access: judge the message alone
  }
  const prompt = `User message (judge this on its own first):\n<message>\n${text}\n</message>\n\nPrevious assistant reply, only to break a tie when the message cannot stand on its own (may be empty):\n<previous>\n${previous}\n</previous>\n\nLabel:`
  const out = (await complete($, GATE_SYSTEM, prompt, 8, CLASSIFY_TIMEOUT)) ?? ''
  const label = out.trim().toUpperCase()
  if (label.startsWith('UNDER')) return 'UNDERSPECIFIED'
  if (label.startsWith('CLEAR')) return 'CLEAR'
  return 'FOLLOWUP'
}

// ---------------------------------------------------------------------------
// Step 2: local context (notes folder + project)
// ---------------------------------------------------------------------------

const PICK_SYSTEM = `You pick which memory files are worth reading for a task. You get the task and an index: one line per file, "- [Title](file.md) - summary".
Return JSON only: {"files": ["file.md", ...]} with at most ${MAX_FACTS} file names that hold facts, preferences, rules or project context relevant to the task. Prefer feedback and project facts over references. Return {"files": []} when nothing fits.`

/**
 * Reads what the notes folder offers (a rules file and a memory index with its fact files), then the project
 * (CLAUDE.md, README, top-level names, git status). Every piece is optional: with no notes folder at all the
 * context is the project alone, and with no project folder it is empty.
 */
async function gatherLocal($: EngineInterface, text: string): Promise<LocalContext> {
  const rulesPath = await resolveIn($, opts.rulesFile)
  const indexPath = await resolveIn($, opts.memoryIndex)
  const memDir = indexPath.slice(0, indexPath.lastIndexOf('/'))
  const rules = await readIf($, rulesPath, 6000)
  const index = await readIf($, indexPath, 20000)

  let facts = ''
  if (index) {
    const out = await complete($, PICK_SYSTEM, `Task:\n${text}\n\nIndex:\n${index}`, 300)
    const picked = parseJson<{ files?: string[] }>(out ?? '')?.files ?? []
    const names = picked.filter(f => /^[\w.-]+\.md$/.test(f)).slice(0, MAX_FACTS)
    for (const name of names) {
      const body = await readIf($, `${memDir}/${name}`, MAX_FACT_CHARS)
      if (body) facts += `\n\n### ${name}\n${body}`
    }
  }

  const cwd = await $.session.cwd().catch(() => '')
  let project = cwd ? `Working folder: ${cwd}\n` : ''
  if (cwd) {
    const claudeMd = await readIf($, `${cwd}/CLAUDE.md`, 4000)
    if (claudeMd) project += `\nCLAUDE.md (project instructions):\n${claudeMd}\n`
    const readme = await readIf($, `${cwd}/README.md`, 1500)
    if (readme) project += `\nREADME.md (head):\n${readme}\n`
    try {
      const entries = await $.fs.list(cwd)
      project += `\nTop-level entries: ${entries.slice(0, 60).map(e => e.name + (e.kind === 'dir' ? '/' : '')).join(', ')}\n`
    } catch {
      // unreadable folder
    }
    try {
      const git = await $.process.run(['git', 'status', '--short', '--branch'], { cwd, timeoutMs: 10000 })
      if (git.exitCode === 0) project += `\ngit status --short --branch:\n${clip(git.stdout, 1500)}\n`
    } catch {
      // not a repository
    }
  }

  const brief = [
    rules ? `## Your rules (${opts.rulesFile}, head)\n${clip(rules, 3500)}` : '',
    facts ? `## Memory facts picked for this task${facts}` : '',
    project ? `## Project\n${project}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
  return { brief, facts, project }
}

// ---------------------------------------------------------------------------
// Step 3: questions
// ---------------------------------------------------------------------------

function questionBudget() {
  return Math.max(1, Math.min(3, Math.round(opts.maxQuestions)))
}

const DRAFT_SYSTEM = `You prepare a short clarification round before a coding/knowledge-work assistant starts a task. The user prefers short, structured text.
Research says: one complete first prompt beats a multi-turn back-and-forth; a few targeted questions beat guessing; weak questions are vague ones. Ask only what the context below does not already answer.
Cover, in priority order, whatever is missing: why the user wants this (the goal or what it is for; if the task states no reason, make this the first question, with options drawn from the context plus a free-text answer), what "done" looks like, scope and what is out of scope, constraints (tools, files, formats, time), how the result will be verified, who it is for.
Return JSON only:
{"questions":[{"question":"...?","header":"<=12 chars","options":[{"label":"1-5 words","description":"one short line"}],"multiSelect":false}],
 "assumptions":["things you will assume if the user does not say otherwise"],
 "searchQueries":["1 or 2 web search queries that would find best practices, research or GitHub repos for this task"]}
Rules: at most {N} questions, 2 to 4 options each with short labels (1-5 words), no "Other" option (the dialog adds free text), headers under 12 characters, questions end with "?". Use the lessons list: they say what this user tends to leave out, so ask about those first when relevant.`

async function draftQuestions($: EngineInterface, text: string, ctx: LocalContext, list: Lesson[]): Promise<Draft> {
  const n = questionBudget()
  const lessonText = list.length ? list.slice(-20).map(l => `- (${l.count}x) ${l.text}`).join('\n') : '- none yet'
  const prompt = `Task the user typed:\n<task>\n${text}\n</task>\n\nLessons about this user's prompts:\n${lessonText}\n\nContext already known (do not ask about what it answers):\n<context>\n${clip(ctx.brief, 14000)}\n</context>`
  const out = await complete($, DRAFT_SYSTEM.replace('{N}', String(n)), prompt, 1200)
  const draft = parseJson<Partial<Draft>>(out ?? '')
  const questions = (draft?.questions ?? [])
    .filter(q => q && typeof q.question === 'string' && Array.isArray(q.options) && q.options.length >= 2)
    .slice(0, n)
    .map(q => ({
      question: q.question.trim().endsWith('?') ? q.question.trim() : `${q.question.trim()}?`,
      header: String(q.header ?? 'Detail').slice(0, 12),
      options: q.options.slice(0, 4).map(o => ({ label: String(o.label).slice(0, 40), description: o.description ? String(o.description).slice(0, 120) : undefined })),
      multiSelect: q.multiSelect === true,
    }))
  return {
    questions,
    assumptions: (draft?.assumptions ?? []).filter(a => typeof a === 'string').slice(0, 6),
    searchQueries: (draft?.searchQueries ?? []).filter(q => typeof q === 'string').slice(0, 2),
  }
}

const GO_Q = 'perfect-prompt: your task looks underspecified. Answer a few quick questions first?'
const GO_YES = 'Yes, ask me'
const GO_RAW = 'No, send as typed'
const WEB_Q = 'Search the web for best practices, research and GitHub repos first?'
const WEB_YES = 'Yes, search'
const WEB_NO = 'No, skip it'

/** One `$.ui.ask` dialog per question (the engine allows plugins no multi-question AskUserQuestion call). A dismissed dialog means "send as typed". */
async function askUser($: EngineInterface, draft: Draft): Promise<{ answers: Record<string, string>; proceedRaw: boolean; web: boolean; free: string }> {
  const none = { answers: {}, proceedRaw: true, web: false, free: '' }
  let go: string
  try {
    go = await $.ui.ask(GO_Q, { options: [GO_YES, GO_RAW], header: 'Perfect' })
  } catch {
    return none
  }
  if (go !== GO_YES) return none
  const answers: Record<string, string> = {}
  for (const q of draft.questions) {
    try {
      const labels = q.options.map(o => o.label).slice(0, 4)
      const a = await $.ui.ask(q.question, { options: labels, header: q.header, ...(q.multiSelect ? { multiSelect: true as const } : {}) })
      if (a.trim()) answers[q.question] = a.trim()
    } catch {
      return none
    }
  }
  let web = opts.webSearch === 'auto'
  if (opts.webSearch === 'ask') {
    try {
      web = (await $.ui.ask(WEB_Q, { options: [WEB_YES, WEB_NO], header: 'Web search' })) === WEB_YES
    } catch {
      web = false
    }
  }
  return { answers, proceedRaw: false, web, free: '' }
}

// ---------------------------------------------------------------------------
// Step 4: web best practices
// ---------------------------------------------------------------------------

const WEB_SYSTEM = `You condense web search results into best practices for a task. Return at most 8 markdown bullets, each one concrete practice, pitfall, library or GitHub repo with its URL in parentheses. Skip marketing. If the results hold nothing useful, return "- nothing useful found".`

async function searchWeb($: EngineInterface, text: string, queries: string[]) {
  const qs = queries.length ? queries : [text.slice(0, 200)]
  let raw = ''
  for (const q of qs.slice(0, 2)) {
    try {
      const r = await $.tool.call({ tool: 'WebSearch', query: q, mode: 'standard' })
      if ('deny' in r && r.deny) continue
      const t = (r as { text?: string }).text ?? JSON.stringify((r as { result?: unknown }).result ?? '')
      raw += `\n\n## Query: ${q}\n${clip(t, MAX_WEB_CHARS / 2)}`
    } catch {
      // a refused or failed search: go on without it
    }
  }
  if (!raw.trim()) return ''
  const out = await complete($, WEB_SYSTEM, `Task:\n${text}\n\nResults:${clip(raw, MAX_WEB_CHARS)}`, 700)
  return out?.trim() ?? ''
}

// ---------------------------------------------------------------------------
// Step 5: assemble
// ---------------------------------------------------------------------------

const ASSEMBLE_SYSTEM = `You write the complete first prompt a user will send to a coding/knowledge-work assistant (Claude Code), from the user's own words plus the answers and context given. You are the drafter; the user reviews before sending.
Write in the user's voice, in plain English, as markdown with these sections in this order. Task, Context, Constraints and rules, What done looks like and Verification are always present. Why, Decisions already made and Best practices to apply appear only when there is something to put in them; never write "none" or "not stated" as a section's content, omit the section instead.
# Task
(the user's request, in their words, tightened)
## Why
(the goal, from the user's words or answers; omit when unknown)
## Context
(by reference: file paths, names, commands, facts that matter; no long dumps; keep every fact as given, invent nothing)
## Constraints and rules
(from the user's rules file, memory facts and answers)
## What done looks like
## Verification
(how the assistant should check its own work: a command, a file to show, a question to ask at the end)
## Decisions already made
(the user's answers to the questions, as statements)
## Best practices to apply
(only when a web summary is given below: its bullets with their URLs)
Rules: spec first, the request last; no padding or praise; do not add requirements the user did not give or imply; keep names, numbers and paths exactly; under 700 words unless the input needs more. Output the prompt only, no preamble.`

/** The web bullets always reach the prompt when a search ran, whatever the model did with the section. */
export function withWebSection(assembled: string, web: string) {
  const bullets = web.trim()
  if (!bullets || /nothing useful found/i.test(bullets)) return assembled
  if (/^## Best practices to apply/m.test(assembled)) return assembled
  return `${assembled.trimEnd()}\n\n## Best practices to apply\n${bullets}\n`
}

async function assemble($: EngineInterface, text: string, ctx: LocalContext, draft: Draft, answers: Record<string, string>, free: string, web: string) {
  const answered = Object.entries(answers).map(([q, a]) => `- ${q} -> ${a}`).join('\n') || '- none'
  const prompt = `User's prompt:\n<prompt>\n${text}\n</prompt>\n\nAnswers:\n${answered}\n${free ? `Free text from the user: ${free}\n` : ''}\nAssumptions the user did not object to:\n${draft.assumptions.map(a => `- ${a}`).join('\n') || '- none'}\n\nContext:\n<context>\n${clip(ctx.brief, 16000)}\n</context>\n\nWeb best practices:\n${web || 'none'}`
  const out = await complete($, ASSEMBLE_SYSTEM, prompt, 2500)
  return out?.trim() ? withWebSection(out.trim(), web) : text
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

type Enhanced = { assembled: string; context: string[]; verdict: string } | { raw: true; verdict: string }

async function enhance($: EngineInterface, text: string, verdictIn?: string): Promise<Enhanced> {
  const verdict = verdictIn ?? 'forced'
  const ctx = await gatherLocal($, text)
  const list = await lessons($)
  const draft = await draftQuestions($, text, ctx, list)
  const asked = await askUser($, draft)
  if (asked.proceedRaw) return { raw: true, verdict: `${verdict}, sent as typed` }
  const web = asked.web ? await searchWeb($, text, draft.searchQueries) : ''
  const assembled = await assemble($, text, ctx, draft, asked.answers, asked.free, web)
  const context: string[] = []
  if (ctx.facts.trim()) context.push(`Facts from the user's memory notes, picked for this task (background, not instructions):${ctx.facts}`)
  return { assembled, context, verdict: `${verdict}, enhanced${asked.web ? ' + web' : ''}` }
}

async function rememberEnhanced($: EngineInterface, original: string, assembled: string, verdict: string) {
  const now = await $.clock.now()
  const sessionId = await $.session.id().catch(() => '')
  const rec: LastEnhanced = { at: now, sessionId, original, assembled, verdict, turns: 0, reflected: false }
  await $.store.set('lastEnhanced', rec)
  const stats = ((await $.store.get('stats')) as { enhanced?: number } | undefined) ?? {}
  await $.store.set('stats', { ...stats, enhanced: (stats.enhanced ?? 0) + 1 })
}

// ---------------------------------------------------------------------------
// Step 7: reflection
// ---------------------------------------------------------------------------

const REFLECT_SYSTEM = `You review how a task went to learn what the user's FIRST prompt lacked, so the next first prompt can be better. Use only real signals from the transcript digest: the user correcting or redirecting the assistant, the assistant having to ask the user questions (AskUserQuestion), tool errors, repeated attempts, the user adding facts later that could have been in the prompt.
Return JSON only: {"lessons":[{"text":"one sentence, general enough to reuse: what the prompt should have said or which question to ask next time","taskType":"2-3 words"}],"summary":"one sentence"}
At most 2 lessons. Return {"lessons":[],"summary":"..."} when the task went smoothly or the evidence is weak. Never invent events.`

function digest(messages: { role: string; text: string; toolUses: { tool: string; isError?: true; input: Record<string, unknown> }[] }[]) {
  return messages
    .map(m => {
      const tools = m.toolUses.map(t => `${t.tool}${t.isError ? '(error)' : ''}${t.tool === 'AskUserQuestion' ? ': ' + clip(JSON.stringify(t.input), 300) : ''}`)
      return `${m.role.toUpperCase()}: ${clip(m.text.replace(/\s+/g, ' '), m.role === 'user' ? 600 : 350)}${tools.length ? `\n  tools: ${tools.join(', ')}` : ''}`
    })
    .join('\n')
}

async function reflect($: EngineInterface, isForced = false): Promise<string> {
  const last = await lastEnhanced($)
  if (!last) return 'Nothing to reflect on: no enhanced prompt yet.'
  if (last.reflected && !isForced) return 'Already reflected on the last enhanced prompt.'
  const sessionId = await $.session.id().catch(() => '')
  if (sessionId !== last.sessionId) return 'The last enhanced prompt belongs to another session; its transcript is not here.'
  let msgs: Awaited<ReturnType<typeof $.session.messages>> = []
  try {
    msgs = await $.session.messages()
  } catch {
    return 'Transcript not readable.'
  }
  const key = last.assembled.slice(0, 80)
  let start = msgs.findIndex(m => m.role === 'user' && m.text.includes(key))
  if (start < 0) start = Math.max(0, msgs.length - 30)
  const slice = msgs.slice(start, start + 60)
  if (slice.length < 2) return 'Too little transcript after the enhanced prompt to learn from.'
  const prompt = `Original prompt:\n<original>\n${clip(last.original, 1500)}\n</original>\n\nEnhanced prompt sent:\n<enhanced>\n${clip(last.assembled, 3000)}\n</enhanced>\n\nTranscript digest after it (${slice.length} messages):\n<digest>\n${clip(digest(slice), 20000)}\n</digest>`
  const out = await complete($, REFLECT_SYSTEM, prompt, 500)
  const parsed = parseJson<{ lessons?: { text: string; taskType?: string }[]; summary?: string }>(out ?? '')
  const found = (parsed?.lessons ?? []).filter(l => l && typeof l.text === 'string' && l.text.trim()).slice(0, 2)
  const now = await $.clock.now()
  let list = await lessons($)
  const added: string[] = []
  for (const l of found) {
    const r = mergeLesson(list, l.text.trim(), (l.taskType ?? 'general').trim(), now)
    list = r.list
    added.push(`${r.isNew ? 'new' : 'repeat'}: ${l.text.trim()}`)
  }
  await $.store.set('lessons', list)
  await $.store.set('lastEnhanced', { ...last, reflected: true })
  if (found.length) await appendLessonsFile($, found.map(l => `${l.text.trim()} [${(l.taskType ?? 'general').trim()}]`), now)
  const line = found.length ? `perfect-prompt: ${found.length} lesson${found.length > 1 ? 's' : ''} saved` : 'perfect-prompt: no lesson this time'
  $.ui.toast(line)
  return `${line}\n${added.join('\n')}\n${parsed?.summary ?? ''}`.trim()
}

/** Appends the lessons to a human-readable file in the notes folder, when that folder exists. The store already holds them. */
async function appendLessonsFile($: EngineInterface, lines: string[], now: number) {
  try {
    const dir = await vaultPath($)
    if (!(await $.fs.exists(dir))) return
    const path = `${dir}/${LESSONS_FILE}`
    let body = (await $.fs.exists(path)) ? await $.fs.read(path) : `# Lessons: perfect-prompt\n\nWhat your first prompts tend to leave out, learned by the perfect-prompt mod after each enhanced task. Dated, append-only; the mod reads its own store, this file is the human copy.\n`
    if (!body.endsWith('\n')) body += '\n'
    const cwd = await $.session.cwd().catch(() => '')
    body += lines.map(l => `- ${dateOf(now)} ${cwd ? `(${cwd.split(/[\\/]/).pop()}) ` : ''}${l}`).join('\n') + '\n'
    await $.fs.write(path, body)
  } catch {
    // the notes folder is optional; the store already holds the lesson
  }
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

function readOptions(options: Readonly<Record<string, unknown>>) {
  const s = (k: keyof Options, d: string) => (typeof options[k] === 'string' && (options[k] as string).trim() ? (options[k] as string).trim() : d)
  const n = (k: keyof Options, d: number) => (typeof options[k] === 'number' && Number.isFinite(options[k]) ? (options[k] as number) : d)
  opts = {
    mode: s('mode', 'review') === 'auto' ? 'auto' : 'review',
    model: s('model', 'haiku'),
    vaultPath: s('vaultPath', '~/.claude'),
    rulesFile: s('rulesFile', 'CLAUDE.md'),
    memoryIndex: s('memoryIndex', 'MEMORY.md'),
    webSearch: (['ask', 'auto', 'off'].includes(s('webSearch', 'ask')) ? s('webSearch', 'ask') : 'ask') as Options['webSearch'],
    maxQuestions: Math.min(3, Math.max(1, n('maxQuestions', 2))),
    minWords: Math.max(1, n('minWords', 12)),
  }
}

export const register: Register = (on, options) => {
  readOptions(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'pp', description: 'Perfect Prompt: /pp <text> enhances it; /pp status | off | on | lessons | forget <n> | reflect | spec', argumentHint: '[text | status | off | on | lessons | forget <n> | reflect | spec]' })
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (!HUMAN.has(e.origin.kind) || e.command || e.isMeta) return next(e)
    const text = e.text.trim()

    // The reviewed prompt comes back: strip the marker, attach the hidden facts, let it through.
    if (text.startsWith(MARKER)) {
      const stripped = text.slice(MARKER.length).trim()
      const p = await read($, pending)
      await update($, pending, () => null)
      const extra = p?.context ?? []
      if (p) await rememberEnhanced($, p.original, stripped, 'reviewed')
      await setBand($, 'enhanced prompt sent')
      return next({ ...e, text: stripped, context: extra.length ? [...(e.context ?? []), ...extra] : e.context })
    }

    if (await read($, isOff)) return next(e)
    if (text.startsWith('>>')) {
      await setBand($, 'sent raw (>>)')
      return next({ ...e, text: text.slice(2).trim() })
    }
    if (wordCount(text) < opts.minWords || isTrivial(text) || looksSecret(text)) return next(e)

    // A new prompt after an enhanced task: learn from that task in the background.
    const last = await lastEnhanced($)
    if (last && !last.reflected && last.turns > 0) $.clock.after(0, () => void reflect($).catch(() => undefined))

    try {
      const verdict = await classifyPrompt($, text)
      if (verdict !== 'UNDERSPECIFIED') {
        await setBand($, verdict === 'CLEAR' ? 'clear, sent as typed' : 'follow-up, sent as typed')
        return next(e)
      }
      $.ui.toast('perfect-prompt: a few questions first')
      const result = await enhance($, text, 'underspecified')
      if ('raw' in result) {
        await setBand($, result.verdict)
        return next(e)
      }
      if (opts.mode === 'auto') {
        await rememberEnhanced($, text, result.assembled, result.verdict)
        await setBand($, `${result.verdict}, sent`)
        return next({ ...e, text: result.assembled, context: result.context.length ? [...(e.context ?? []), ...result.context] : e.context })
      }
      const p: Pending = { context: result.context, original: text, assembled: result.assembled, at: await $.clock.now() }
      await update($, pending, () => p)
      const filled = await $.prompt.fill({ text: `${MARKER}\n${result.assembled}` })
      if (!filled.isFilled) {
        await setBand($, `${result.verdict}, box busy: sent as typed`)
        return next(e)
      }
      await setBand($, `${result.verdict}: review the prompt in your box`)
      return { drop: 'perfect-prompt: the enhanced prompt is in your prompt box. Edit it, then press Enter. (Start with >> to send a prompt raw, /pp off to pause.)' }
    } catch (err) {
      await setBand($, `error, sent as typed (${err instanceof Error ? err.message.slice(0, 80) : 'unknown'})`).catch(() => undefined)
      return next(e)
    }
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && e.reason === 'answer') {
      const last = await lastEnhanced($).catch(() => undefined)
      if (last && !last.reflected) await $.store.set('lastEnhanced', { ...last, turns: last.turns + 1 }).catch(() => undefined)
    }
    return next(e)
  })

  on('command.run', { command: 'pp' }, async ($, e) => {
    const args = e.args.trim()
    const [word, ...rest] = args.split(/\s+/)
    const sub = (word ?? '').toLowerCase()
    if (sub === '' || sub === 'status') {
      const off = await read($, isOff)
      const list = await lessons($)
      const last = await lastEnhanced($)
      const stats = ((await $.store.get('stats')) as { enhanced?: number } | undefined) ?? {}
      return {
        text: [
          `perfect-prompt ${off ? 'OFF for this session' : 'on'} · mode ${opts.mode} · model ${opts.model} · web ${opts.webSearch} · ${questionBudget()} question(s) per round`,
          `notes folder ${await vaultPath($)} · rules ${opts.rulesFile} · memory index ${opts.memoryIndex} · lessons ${LESSONS_FILE}`,
          `${stats.enhanced ?? 0} prompts enhanced in all · ${list.length} lessons · ${sessionTokens} cheap-model tokens this session`,
          last ? `last enhanced ${dateOf(last.at)}: ${last.verdict}, ${last.turns} turn(s) after it, ${last.reflected ? 'reflected' : 'not yet reflected'}` : 'no enhanced prompt yet',
          'Usage: type normally (long new tasks get questions) · >> sends raw · /pp <text> enhances that text · /pp off | on | lessons | forget <n> | reflect | spec',
        ].join('\n'),
      }
    }
    if (sub === 'off' || sub === 'on') {
      await update($, isOff, () => sub === 'off')
      return { text: sub === 'off' ? 'perfect-prompt is off for this session. /pp on brings it back.' : 'perfect-prompt is on.' }
    }
    if (sub === 'lessons') {
      const list = await lessons($)
      if (list.length === 0) return { text: 'No lessons yet. They appear after an enhanced task ends and you start the next one, or after /pp reflect.' }
      return { text: list.map((l, i) => `${i + 1}. (${l.count}x, ${dateOf(l.lastAt)}, ${l.taskType}) ${l.text}`).join('\n') }
    }
    if (sub === 'forget') {
      const n = Number(rest[0])
      const list = await lessons($)
      if (!Number.isInteger(n) || n < 1 || n > list.length) return { text: `Give a lesson number from 1 to ${list.length}.` }
      const [gone] = list.splice(n - 1, 1)
      await $.store.set('lessons', list)
      return { text: `Forgot: ${gone?.text ?? ''}` }
    }
    if (sub === 'reflect') return { text: await reflect($, true) }
    if (sub === 'spec') {
      const last = await lastEnhanced($)
      const p = await read($, pending)
      const body = p?.assembled ?? last?.assembled
      if (!body) return { text: 'No assembled prompt to write yet.' }
      const cwd = await $.session.cwd().catch(() => '')
      const path = `${cwd}/SPEC-perfect-prompt.md`
      await $.fs.write(path, `${body}\n`)
      return { text: `Wrote ${path}. Start a fresh session and paste or @-mention it (the "consolidate and restart" move).` }
    }
    // Anything else is a prompt to enhance now.
    if (await read($, isOff)) return { text: 'perfect-prompt is off for this session. /pp on first.' }
    try {
      const result = await enhance($, args, 'forced')
      if ('raw' in result) {
        const back = await $.prompt.fill({ text: `>> ${args}` })
        return { text: back.isFilled ? 'Your prompt is back in the box as typed (with >> so it goes through untouched). Press Enter to send it.' : `Kept as typed. Your text: ${args}` }
      }
      const p: Pending = { context: result.context, original: args, assembled: result.assembled, at: await $.clock.now() }
      await update($, pending, () => p)
      const filled = await $.prompt.fill({ text: `${MARKER}\n${result.assembled}` })
      await setBand($, `${result.verdict}: review the prompt in your box`)
      return { text: filled.isFilled ? 'The enhanced prompt is in your prompt box. Edit it, then press Enter.' : 'Could not fill the prompt box (is it empty?). Run /pp spec to write the prompt to a file instead.' }
    } catch (err) {
      return { text: `perfect-prompt failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const b = await read($, band)
    const off = await read($, isOff)
    if ((b === null && !off) || (await read($, isHidden))) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const below = await next(e)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text dimColor wrap="truncate-end">
            {`perfect-prompt · ${off ? 'off this session' : b?.verdict ?? 'on'} · ${sessionTokens} tokens`}
          </Text>
          <Button key="pp-toggle" label={off ? 'On' : 'Off'} onPress={() => update($, isOff, v => !v)} />
          <Button key="pp-hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
        </Box>
        {below}
      </Box>
    )
  })
}
