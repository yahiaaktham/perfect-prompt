import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { mergeLesson, parseJson, similarity, withWebSection, wordCount } from './register'

const MARKER = '<!-- perfect-prompt:v1 -->'
const ORIGIN = { kind: 'composer' } as const
const USAGE = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const LONG = 'Please build me a small script that cleans up my downloads folder and sorts the files into folders by type and month'

const QUESTIONS = {
  questions: [
    { question: 'Which folder is it?', header: 'Folder', options: [{ label: 'Downloads', description: 'the default' }, { label: 'Another one' }], multiSelect: false },
  ],
  assumptions: ['Python is fine'],
  searchQueries: ['organize downloads folder script best practices'],
}

type World = {
  verdict: string
  assembled: string
  cont: string
  fills: string[]
  previous: string
  gatePrompts: string[]
  draftPrompts: string[]
  /** Files that exist beneath the mod, keyed by the tail of their path. */
  files: Record<string, string>
  /** What the fact picker answers. */
  pick: string
}

/** Everything beneath the mod, answered from memory: no file, process, model or dialog is real here. */
function world(on: On, w: Partial<World> = {}): World {
  const state: World = { verdict: 'FOLLOWUP', assembled: 'ASSEMBLED PROMPT', cont: 'Yes, ask me', fills: [], previous: '', gatePrompts: [], draftPrompts: [], files: {}, pick: '{"files":[]}', ...w }
  const fileFor = (path: unknown) => Object.keys(state.files).find(k => String(path).replace(/\\/g, '/').endsWith(k))
  mock.clock(on, { now: 1_700_000_000_000 })
  mock.store(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'pp' } }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  on('prompt.fill', (_, e) => {
    state.fills.push(e.text)
    return { isFilled: true }
  })
  on('session.messages', () => ({ value: state.previous ? [{ role: 'user', text: 'earlier', toolUses: [] }, { role: 'assistant', text: state.previous, toolUses: [] }] : [] }))
  on('session.turns', () => ({ value: 0 }))
  on('session.cwd', () => ({ value: '/' }))
  on('session.id', () => ({ value: 'session-1' }))
  on('fs.exists', (_, e) => ({ value: fileFor(e.path) !== undefined }))
  on('fs.read', (_, e) => ({ value: state.files[fileFor(e.path) ?? ''] ?? '' }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('model.complete', (_, e) => {
    const sys = typeof e.system === 'string' ? e.system : ''
    const prompt = typeof e.prompt === 'string' ? e.prompt : ''
    let text = 'FOLLOWUP'
    if (sys.includes('You classify')) {
      state.gatePrompts.push(prompt)
      text = state.verdict
    }
    else if (sys.includes('pick which memory')) text = state.pick
    else if (sys.includes('clarification round')) {
      state.draftPrompts.push(prompt)
      text = JSON.stringify(QUESTIONS)
    }
    else if (sys.includes('complete first prompt')) text = state.assembled
    else if (sys.includes('review how a task went')) text = '{"lessons":[{"text":"Say which folder and what done looks like","taskType":"file cleanup"}],"summary":"fine"}'
    return { value: { isAnswered: true, text, usage: USAGE } }
  })
  // $.ui.ask is a tool.call of AskUserQuestion beneath the plugin; answer it by question text.
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const answers: Record<string, string> = {}
    for (const q of e.questions) {
      if (q.question.startsWith('perfect-prompt: your task')) answers[q.question] = state.cont
      else if (q.question.startsWith('Search the web')) answers[q.question] = 'No, skip it'
      else if (q.question === 'Which folder is it?') answers[q.question] = 'Downloads'
      else answers[q.question] = ''
    }
    return { result: { questions: e.questions, answers } }
  })
  return state
}

test('the pure helpers behave', async () => {
  expect(wordCount('  a b   c ')).toBe(3)
  expect(parseJson<{ a: number }>('Sure:\n```json\n{"a": 1}\n```')?.a).toBe(1)
  expect(parseJson('no json here')).toBeUndefined()
  expect(similarity('say which folder and what done looks like', 'state the folder and what done looks like')).toBeGreaterThanOrEqual(0.6)
  const first = mergeLesson([], 'Say what done looks like for the script', 'script', 1)
  expect(first.isNew).toBe(true)
  const again = mergeLesson(first.list, 'Say what done looks like for the script', 'script', 2)
  expect(again.isNew).toBe(false)
  expect(again.list[0]?.count).toBe(2)
  expect(withWebSection('# Task\nx', '')).toBe('# Task\nx')
  expect(withWebSection('# Task\nx', '- nothing useful found')).toBe('# Task\nx')
  expect(withWebSection('# Task\nx', '- use rsync (https://example.org)')).toContain('## Best practices to apply\n- use rsync')
  expect(withWebSection('# Task\n## Best practices to apply\n- kept', '- new')).toBe('# Task\n## Best practices to apply\n- kept')
})

test('a short prompt passes unchanged with no model call', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const r = await $.prompt.submit({ text: 'ok', origin: ORIGIN, wait: false })
  expect(r).toEqual({ text: 'ok', context: undefined })
})

test('>> sends the prompt raw, prefix removed', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const r = await $.prompt.submit({ text: `>> ${LONG}`, origin: ORIGIN, wait: false })
  expect('text' in r && r.text).toBe(LONG)
})

test('a follow-up passes unchanged', async ($, on) => {
  world(on, { verdict: 'FOLLOWUP' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const r = await $.prompt.submit({ text: LONG, origin: ORIGIN, wait: false })
  expect('text' in r && r.text).toBe(LONG)
})

test('an underspecified prompt is held and the assembled prompt fills the box', async ($, on) => {
  const w = world(on, { verdict: 'UNDERSPECIFIED' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const r = await $.prompt.submit({ text: LONG, origin: ORIGIN, wait: false })
  expect('drop' in r && typeof r.drop === 'string').toBe(true)
  expect(w.fills.length).toBe(1)
  expect(w.fills[0]?.startsWith(MARKER)).toBe(true)
  expect(w.fills[0]?.includes('ASSEMBLED PROMPT')).toBe(true)

  // The reviewed prompt comes back: the marker goes, the text reaches the model.
  const back = await $.prompt.submit({ text: `${MARKER}\nASSEMBLED PROMPT, edited`, origin: ORIGIN, wait: false })
  expect('text' in back && back.text).toBe('ASSEMBLED PROMPT, edited')
})

test('choosing "as typed" in the dialog sends the original', async ($, on) => {
  const w = world(on, { verdict: 'UNDERSPECIFIED', cont: 'No, send as typed' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const r = await $.prompt.submit({ text: LONG, origin: ORIGIN, wait: false })
  expect('text' in r && r.text).toBe(LONG)
  expect(w.fills.length).toBe(0)
})

test('a plugin-origin prompt is never touched', async ($, on) => {
  world(on, { verdict: 'UNDERSPECIFIED' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const r = await $.prompt.submit({ text: LONG, origin: { kind: 'plugin', name: 'other' }, wait: false })
  expect('text' in r && r.text).toBe(LONG)
})

test('the band above the prompt shows the verdict and an Off button', async ($, on) => {
  world(on, { verdict: 'FOLLOWUP' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: LONG, origin: ORIGIN, wait: false })
  const ui = await $.ui.mount({ plugin: 'perfect-prompt', component: 'AbovePrompt', surface: 'desktop', props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 120, scroll: { offset: 0, bodyRows: 6 }, view: {} } })
  const row = await ui.find({ type: 'Text', text: /perfect-prompt/ })
  expect(row?.text ?? '').toContain('follow-up, sent as typed')
  await ui.press({ key: 'pp-toggle' })
  const after = await ui.find({ type: 'Text', text: /perfect-prompt/ })
  expect(after?.text ?? '').toContain('off this session')
  await ui.unmount()
})

test('a long previous reply is clipped, placed after the message, and does not stop the questions', async ($, on) => {
  const w = world(on, { verdict: 'UNDERSPECIFIED', previous: 'Here is what we did in the test so far. '.repeat(80) })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const r = await $.prompt.submit({ text: LONG, origin: ORIGIN, wait: false })
  expect('drop' in r && typeof r.drop === 'string').toBe(true)
  expect(w.gatePrompts.length).toBe(1)
  const gate = w.gatePrompts[0] ?? ''
  expect(gate.indexOf('<message>')).toBeLessThan(gate.indexOf('<previous>'))
  expect(gate).toContain('judge this on its own first')
  const previous = gate.slice(gate.indexOf('<previous>'), gate.indexOf('</previous>'))
  expect(previous.length).toBeLessThan(520)
  expect(gate).not.toContain('Turns so far')
})

test('with no notes folder the questions are drafted from the project alone', async ($, on) => {
  const w = world(on, { verdict: 'UNDERSPECIFIED', files: { '/README.md': 'PROJECT-README' } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const r = await $.prompt.submit({ text: LONG, origin: ORIGIN, wait: false })
  expect('drop' in r && typeof r.drop === 'string').toBe(true)
  expect(w.draftPrompts.length).toBe(1)
  const draft = w.draftPrompts[0] ?? ''
  expect(draft).not.toContain('## Your rules')
  expect(draft).not.toContain('## Memory facts')
  expect(draft).toContain('PROJECT-README')
})

test('a rules file and a memory index in the notes folder reach the question drafter and ride along as context', async ($, on) => {
  const w = world(on, {
    verdict: 'UNDERSPECIFIED',
    files: { '/.claude/CLAUDE.md': 'RULE-TEXT: never delete without asking', '/.claude/MEMORY.md': '- [Folders](fact.md) - how folders are sorted', '/.claude/fact.md': 'FACT-TEXT: sort by month' },
    pick: '{"files":["fact.md"]}',
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const r = await $.prompt.submit({ text: LONG, origin: ORIGIN, wait: false })
  expect('drop' in r && typeof r.drop === 'string').toBe(true)
  const draft = w.draftPrompts[0] ?? ''
  expect(draft).toContain('## Your rules (CLAUDE.md, head)')
  expect(draft).toContain('RULE-TEXT')
  expect(draft).toContain('## Memory facts picked for this task')
  expect(draft).toContain('FACT-TEXT')

  // The reviewed prompt comes back with the picked facts as hidden context.
  const back = await $.prompt.submit({ text: `${MARKER}\nASSEMBLED PROMPT`, origin: ORIGIN, wait: false })
  const context = 'context' in back ? back.context ?? [] : []
  expect(context.some(c => c.includes('FACT-TEXT'))).toBe(true)
})
