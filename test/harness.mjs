/**
 * Offline harness for dsh-composer-phrases/lib/client.js.
 *
 * The shell resolves React from its own runtime module table, so React does not
 * exist on this machine and cannot be imported here. This harness therefore
 * supplies a minimal React stand-in (state, effects with cleanup, refs) plus a
 * fake DOM, a fake localStorage and a fake composer face, then drives the real
 * component through every branch: slot registration, style-tag lifecycle, panel
 * open/close, outside-click, caret insert, insert retry + fallback, busy-state
 * gating, add, delete, and storage degradation.
 *
 * It is a logic-level test: it proves the plugin's contract and behavior, not
 * React's rendering. The end-to-end proof is clicking the arrow in the real GUI.
 *
 * Run: node test/harness.mjs
 */
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = join(here, '..', 'lib', 'client.js')

let failures = 0
let checks = 0

function ok(condition, label, detail = '') {
	checks += 1
	if (condition) {
		console.log(`  PASS  ${label}`)
		return
	}
	failures += 1
	console.log(`  FAIL  ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

function eq(actual, expected, label) {
	ok(Object.is(actual, expected), label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

/* ------------------------------------------------------------------ *
 * Fake DOM
 * ------------------------------------------------------------------ */

class FakeElement {
	constructor(tag) {
		this.tagName = String(tag).toUpperCase()
		this.dataset = {}
		this.textContent = ''
		this.children = []
		this.parentNode = undefined
		this.removed = false
	}
	appendChild(child) {
		child.parentNode = this
		this.children.push(child)
		return child
	}
	remove() {
		this.removed = true
		const parent = this.parentNode
		if (parent !== undefined) parent.children = parent.children.filter((child) => child !== this)
	}
}

const head = new FakeElement('head')
const listeners = new Map()

globalThis.document = {
	head,
	createElement: (tag) => new FakeElement(tag),
	addEventListener: (type, fn) => {
		const list = listeners.get(type) ?? []
		list.push(fn)
		listeners.set(type, list)
	},
	removeEventListener: (type, fn) => {
		const list = listeners.get(type) ?? []
		listeners.set(
			type,
			list.filter((entry) => entry !== fn),
		)
	},
}

function dispatch(type, event) {
	for (const fn of [...(listeners.get(type) ?? [])]) fn(event)
}

const listenerCount = (type) => (listeners.get(type) ?? []).length

/* ------------------------------------------------------------------ *
 * Fake localStorage
 * ------------------------------------------------------------------ */

const store = new Map()
globalThis.localStorage = {
	getItem: (key) => (store.has(key) ? store.get(key) : null),
	setItem: (key, value) => void store.set(key, String(value)),
	removeItem: (key) => void store.delete(key),
}

/* ------------------------------------------------------------------ *
 * Network tripwire: the plugin must never reach out.
 * ------------------------------------------------------------------ */

let networkCalls = 0
globalThis.fetch = () => {
	networkCalls += 1
	throw new Error('network access attempted')
}

/* ------------------------------------------------------------------ *
 * Minimal React stand-in: state, effects (with cleanup), refs, re-render loop
 * ------------------------------------------------------------------ */

let hookSlots = []
let hookCursor = 0
let effectSlots = new Map()
let pendingEffects = []
let mounted = null
let pendingRender = false

function createElement(type, props, ...children) {
	const merged = { ...(props ?? {}) }
	if (children.length === 1) merged.children = children[0]
	else if (children.length > 1) merged.children = children
	return { type, props: merged }
}

const React = {
	createElement,
	Fragment: Symbol('Fragment'),
	useState(initial) {
		const index = hookCursor
		hookCursor += 1
		if (!(index in hookSlots)) hookSlots[index] = typeof initial === 'function' ? initial() : initial
		const setState = (value) => {
			hookSlots[index] = typeof value === 'function' ? value(hookSlots[index]) : value
			pendingRender = true
		}
		return [hookSlots[index], setState]
	},
	useEffect(fn, deps) {
		const index = hookCursor
		hookCursor += 1
		pendingEffects.push({ index, fn, deps })
	},
	useMemo(fn) {
		const index = hookCursor
		hookCursor += 1
		return fn()
	},
	useRef(initial) {
		const index = hookCursor
		hookCursor += 1
		if (!(index in hookSlots)) hookSlots[index] = { current: initial }
		return hookSlots[index]
	},
}

const sameDeps = (left, right) =>
	left !== undefined &&
	right !== undefined &&
	left.length === right.length &&
	left.every((value, index) => Object.is(value, right[index]))

function commitEffects() {
	for (const pending of pendingEffects) {
		const previous = effectSlots.get(pending.index)
		if (previous !== undefined && sameDeps(previous.deps, pending.deps)) continue
		if (previous !== undefined && typeof previous.cleanup === 'function') previous.cleanup()
		const cleanup = pending.fn()
		effectSlots.set(pending.index, {
			deps: pending.deps,
			cleanup: typeof cleanup === 'function' ? cleanup : undefined,
		})
	}
	pendingEffects = []
}

/** Give every host node carrying a ref a stand-in DOM root with contains(). */
function attachRefs(tree) {
	walk(tree, (node) => {
		const ref = node.props?.ref
		if (ref !== undefined && ref !== null && typeof ref === 'object' && 'current' in ref) {
			ref.current = { contains: (target) => target !== undefined && target !== null && target.__insideQp === true }
		}
	})
}

function renderWith(props) {
	hookCursor = 0
	pendingRender = false
	pendingEffects = []
	const tree = mounted.component(props)
	mounted.tree = tree
	attachRefs(tree)
	commitEffects()
	return tree
}

/** Run a handler, then re-render and re-commit effects (mirrors React's commit). */
function act(fn) {
	const result = fn()
	if (pendingRender) {
		pendingRender = false
		renderWith(mounted.props)
	}
	return result === undefined ? mounted.tree : result
}

/* ------------------------------------------------------------------ *
 * Tree helpers
 * ------------------------------------------------------------------ */

function walk(node, visit) {
	if (node === null || node === undefined || typeof node !== 'object') return
	if (Array.isArray(node)) {
		for (const child of node) walk(child, visit)
		return
	}
	visit(node)
	walk(node.props?.children, visit)
}

function findAll(tree, predicate) {
	const found = []
	walk(tree, (node) => {
		if (predicate(node)) found.push(node)
	})
	return found
}

const classOf = (node) => (typeof node.props?.className === 'string' ? node.props.className : '')

const byClass = (tree, name) => findAll(tree, (node) => classOf(node).includes(name))
const picks = (tree) => byClass(tree, 'dsh-qp__pick')
const dels = (tree) => byClass(tree, 'dsh-qp__del')
const panelOf = (tree) => byClass(tree, 'dsh-qp__panel')[0]
const triggerOf = (tree) => byClass(tree, 'dsh-qp__trigger')[0]
const inputOf = (tree) => byClass(tree, 'dsh-qp__input')[0]
const buttonByText = (tree, text) => findAll(tree, (node) => node.type === 'button' && node.props?.children === text)[0]
const hintOf = (tree) => byClass(tree, 'dsh-qp__hint')[0]

/* ------------------------------------------------------------------ *
 * Load the real plugin bundle
 * ------------------------------------------------------------------ */

const loaded = []
globalThis.window = { __ModuleLoader__: { load: (entry) => loaded.push(entry) } }

await import(`${pathToFileURL(CLIENT_PATH).href}?t=${Date.now()}`)

console.log('\n[ bundle handoff ]')
eq(loaded.length, 1, 'exactly one __ModuleLoader__.load call')
const entry = loaded[0]
eq(entry.id, 'dsh-composer-phrases', 'bundle id matches the package name')
ok(typeof entry.factory === 'function', 'factory is a function')

const requiredIds = []
const moduleExports = entry.factory((id) => {
	requiredIds.push(id)
	if (id === 'react') return React
	throw new Error(`unexpected require("${id}") — only the shell module table is allowed`)
})

eq(requiredIds.join(','), 'react', 'requires only the shell-provided react')
ok(typeof moduleExports.apply === 'function', 'exports.apply')
eq(JSON.stringify(moduleExports.inject), '["slots"]', 'exports.inject = ["slots"]')

/* ------------------------------------------------------------------ *
 * apply(): stylesheet + slot seat
 * ------------------------------------------------------------------ */

console.log('\n[ apply(): stylesheet ownership ]')
const disposers = []
const registrations = []
const ctx = {
	effect: (callback, label) => {
		disposers.push({ label, disposer: callback() })
		return () => {}
	},
	slots: {
		inject: (slot, callback) => {
			registrations.push({ slot, callback })
			return () => {}
		},
		register: (options, component) => {
			registrations.push({ options, component })
			return () => {}
		},
	},
}

moduleExports.apply(ctx)

const styleTags = head.children.filter((el) => el.tagName === 'STYLE')
eq(styleTags.length, 1, 'one stylesheet injected')
eq(styleTags[0].dataset.plugin, 'dsh-composer-phrases', 'style tag owned by this plugin')
ok(styleTags[0].textContent.includes('.dsh-qp__panel'), 'stylesheet carries the panel rules')
ok(styleTags[0].textContent.includes('.dsh-qp__trigger'), 'stylesheet carries the arrow rules')
ok(styleTags[0].textContent.includes('--dsw-alias-'), 'stylesheet uses shell theme tokens')

eq(disposers.length, 1, 'stylesheet registered one disposer')
ok(disposers[0].label.includes('dsh-composer-phrases'), 'disposer is labelled')

const seatInject = registrations.find((entry) => entry.slot === 'conversation.input.left')
ok(seatInject !== undefined, 'waits on conversation.input.left (the composer tool row)')
seatInject.callback()
const registration = registrations.find((entry) => entry.options !== undefined && entry.options.name === 'conversation.input.left')
ok(registration !== undefined, 'takes the tool-row seat beside the permission chip')
eq(registration.options.id, 'composer-phrases', 'seat id')
eq(registration.options.order, 0, 'seat order')
eq(registration.component, moduleExports.QuickPhrases, 'slot renders the exported component')

/* ------------------------------------------------------------------ *
 * Behavior at the seat
 * ------------------------------------------------------------------ */

const defaults = ['继续', '先给我几个方案', '用大白话解释', '总结一下', '列出要改的文件', '先写测试']

const composer = (fake) => ({ phase: 'idle', draft: '', attachmentIds: [], queue: [], ...fake })
const inputHook = (fake) => (selector) => selector(composer(fake))

/** Simulate React unmounting the previous tree: every effect cleanup runs. */
function unmount() {
	for (const slot of effectSlots.values()) {
		if (typeof slot.cleanup === 'function') slot.cleanup()
	}
	effectSlots = new Map()
	pendingEffects = []
	hookSlots = []
}

function mount(props) {
	unmount()
	const full = { useInput: inputHook(), ...props }
	mounted = { component: moduleExports.QuickPhrases, props: full, tree: null }
	return renderWith(full)
}

console.log('\n[ closed by default: only a small arrow ]')
let tree = mount({ inputActions: {} })
ok(triggerOf(tree) !== undefined, 'arrow button rendered')
eq(triggerOf(tree).props.children, '短语 ▴', 'trigger reads as a labelled arrow while closed')
eq(panelOf(tree), undefined, 'no panel before it is opened')
eq(listenerCount('mousedown'), 0, 'no global listener while closed')

console.log('\n[ open: a vertical panel of phrases ]')
tree = mount({ inputActions: {} })
tree = act(() => triggerOf(tree).props.onClick())
ok(panelOf(tree) !== undefined, 'panel opens')
eq(triggerOf(tree).props.children, '短语 ▾', 'arrow flips while open')
eq(picks(tree).length, defaults.length, `lists ${defaults.length} phrases`)
eq(picks(tree)[0].props.children, '继续', 'first row label')
eq(byClass(tree, 'dsh-qp__head')[0].props.children, '常用短语', 'panel heading')
ok(inputOf(tree) !== undefined, 'add field present')
ok(buttonByText(tree, '添加') !== undefined, 'add button present')
eq(dels(tree).length, defaults.length, 'every row offers a delete control')
eq(listenerCount('mousedown'), 1, 'outside-click listener armed while open')

console.log('\n[ pick = caret insert, then close ]')
const insertCalls = []
const draftCalls = []
const actions = {
	captureInsertion: () => ({ start: 3, end: 3, draftRev: 7 }),
	insertText: (text, span) => {
		insertCalls.push({ text, span })
		return true
	},
	setDraft: (text) => void draftCalls.push(text),
}
tree = mount({ inputActions: actions, useInput: inputHook({ draft: '已打的字' }) })
tree = act(() => triggerOf(tree).props.onClick())
tree = act(() => picks(tree)[0].props.onClick())
eq(insertCalls.length, 1, 'insertText called once')
eq(insertCalls[0].text, '继续', 'inserted the picked phrase')
eq(insertCalls[0].span.draftRev, 7, 'insertion span came from captureInsertion')
eq(draftCalls.length, 0, 'setDraft untouched when the caret insert succeeds')
eq(panelOf(tree), undefined, 'panel closes after picking')
eq(listenerCount('mousedown'), 0, 'outside-click listener removed with the panel')

console.log('\n[ stale revision: retried, then setDraft fallback ]')
insertCalls.length = 0
draftCalls.length = 0
const stale = { ...actions, insertText: (text) => { insertCalls.push(text); return false } }
tree = mount({ inputActions: stale, useInput: inputHook({ draft: '已打的字' }) })
tree = act(() => triggerOf(tree).props.onClick())
tree = act(() => picks(tree)[1].props.onClick())
eq(insertCalls.length, 2, 'insertText retried once before giving up')
eq(draftCalls.length, 1, 'setDraft used as the last resort')
eq(draftCalls[0], '已打的字 先给我几个方案', 'fallback appends with a separator')
eq(hintOf(tree)?.props.children, '已追加到输入框末尾', 'fallback says it appended')

console.log('\n[ fallback: no separator when the draft already ends in whitespace ]')
insertCalls.length = 0
draftCalls.length = 0
const stale2 = { ...actions, insertText: () => false }
tree = mount({ inputActions: stale2, useInput: inputHook({ draft: '已打的字 ' }) })
tree = act(() => triggerOf(tree).props.onClick())
tree = act(() => picks(tree)[1].props.onClick())
eq(draftCalls[0], '已打的字 先给我几个方案', 'no doubled whitespace at the append point')

console.log('\n[ a clean caret insert leaves no hint ]')
insertCalls.length = 0
draftCalls.length = 0
tree = mount({ inputActions: actions, useInput: inputHook({ draft: 'abc' }) })
tree = act(() => triggerOf(tree).props.onClick())
tree = act(() => picks(tree)[0].props.onClick())
eq(hintOf(tree), undefined, 'no hint after the caret insert succeeded')

console.log('\n[ no composer face: inert, never throws ]')
tree = mount({ inputActions: undefined })
tree = act(() => triggerOf(tree).props.onClick())
let threw = null
try {
	tree = act(() => picks(tree)[0].props.onClick())
} catch (error) {
	threw = error
}
ok(threw === null, 'picking without inputActions does not throw', String(threw))
eq(hintOf(tree)?.props.children, '输入框不可用', 'says the composer is unavailable')

console.log('\n[ busy composer disables the rows ]')
tree = mount({ inputActions: actions, useInput: inputHook({ phase: 'submitting' }) })
tree = act(() => triggerOf(tree).props.onClick())
eq(picks(tree)[0].props.disabled, true, 'rows disabled while submitting')
tree = mount({ inputActions: actions, useInput: inputHook({ phase: 'adjudicating' }) })
tree = act(() => triggerOf(tree).props.onClick())
eq(picks(tree)[0].props.disabled, true, 'rows disabled while adjudicating')
tree = mount({ inputActions: actions, useInput: inputHook({ phase: 'idle' }) })
tree = act(() => triggerOf(tree).props.onClick())
eq(picks(tree)[0].props.disabled, false, 'rows enabled when idle')

console.log('\n[ add a phrase ]')
tree = mount({ inputActions: actions })
tree = act(() => triggerOf(tree).props.onClick())
tree = act(() => inputOf(tree).props.onChange({ target: { value: '  写周报  ' } }))
eq(inputOf(tree).props.value, '  写周报  ', 'field keeps what was typed')
tree = act(() => buttonByText(tree, '添加').props.onClick())
eq(picks(tree).length, defaults.length + 1, 'one row added')
eq(picks(tree)[defaults.length].props.children, '写周报', 'added row is trimmed')
eq(inputOf(tree).props.value, '', 'field cleared after adding')
eq(JSON.parse(store.get('dsh-composer-phrases/phrases/v1')).pop(), '写周报', 'added phrase persisted')
eq(panelOf(tree) === undefined, false, 'panel stays open for another pick')

console.log('\n[ add via Enter, ignore blanks and duplicates ]')
const before = picks(tree).length
tree = act(() => inputOf(tree).props.onChange({ target: { value: '做备份' } }))
tree = act(() => inputOf(tree).props.onKeyDown({ key: 'Enter', preventDefault: () => {} }))
eq(picks(tree).length, before + 1, 'Enter adds the phrase')
tree = act(() => inputOf(tree).props.onChange({ target: { value: '   ' } }))
tree = act(() => buttonByText(tree, '添加').props.onClick())
eq(picks(tree).length, before + 1, 'blank input adds nothing')
tree = act(() => inputOf(tree).props.onChange({ target: { value: '做备份' } }))
tree = act(() => buttonByText(tree, '添加').props.onClick())
eq(picks(tree).length, before + 1, 'duplicate adds nothing')
tree = act(() => inputOf(tree).props.onKeyDown({ key: 'a', preventDefault: () => {} }))
eq(picks(tree).length, before + 1, 'other keys do not add')

console.log('\n[ saved phrases survive a remount ]')
const saved = JSON.parse(store.get('dsh-composer-phrases/phrases/v1'))
tree = mount({ inputActions: actions })
tree = act(() => triggerOf(tree).props.onClick())
eq(picks(tree).length, saved.length, 'remount restores the saved list')

console.log('\n[ delete a phrase ]')
const target = picks(tree)[0].props.children
tree = act(() => dels(tree)[0].props.onClick())
eq(picks(tree).length, saved.length - 1, 'one row removed')
ok(!picks(tree).some((row) => row.props.children === target), 'the clicked row is gone')
eq(JSON.parse(store.get('dsh-composer-phrases/phrases/v1')).includes(target), false, 'removal persisted')

console.log('\n[ delete everything: the list stays empty, never resurrected ]')
let guard = 0
while (picks(tree).length > 0 && guard < 40) {
	tree = act(() => dels(tree)[0].props.onClick())
	guard += 1
}
eq(picks(tree).length, 0, 'the list can be emptied (seeds are not resurrected)')
eq(byClass(tree, 'dsh-qp__empty').length, 1, 'an empty panel explains itself')
eq(JSON.parse(store.get('dsh-composer-phrases/phrases/v1')).length, 0, 'the empty list is persisted')
tree = act(() => inputOf(tree).props.onChange({ target: { value: '重新来一条' } }))
tree = act(() => buttonByText(tree, '添加').props.onClick())
eq(picks(tree).length, 1, 'adding revives the panel')
eq(byClass(tree, 'dsh-qp__empty').length, 0, 'the empty hint disappears')

console.log('\n[ outside click closes, inside click keeps open ]')
tree = mount({ inputActions: actions })
tree = act(() => triggerOf(tree).props.onClick())
ok(panelOf(tree) !== undefined, 'panel opened')
eq(listenerCount('mousedown'), 1, 'outside-click listener armed')
tree = act(() => dispatch('mousedown', { target: { __insideQp: true } }))
ok(panelOf(tree) !== undefined, 'a click inside the panel leaves it open')
tree = act(() => dispatch('mousedown', { target: {} }))
eq(panelOf(tree), undefined, 'a click outside closes the panel')
eq(listenerCount('mousedown'), 0, 'no listener left after closing')

console.log('\n[ corrupt storage degrades to defaults ]')
store.set('dsh-composer-phrases/phrases/v1', '{not json')
tree = mount({ inputActions: actions })
tree = act(() => triggerOf(tree).props.onClick())
eq(picks(tree).length, defaults.length, 'invalid JSON falls back to the seeds')
store.set('dsh-composer-phrases/phrases/v1', '[]')
tree = mount({ inputActions: actions })
tree = act(() => triggerOf(tree).props.onClick())
eq(picks(tree).length, 0, 'an explicitly emptied stored list stays empty')
eq(byClass(tree, 'dsh-qp__empty').length, 1, 'and explains itself')
store.delete('dsh-composer-phrases/phrases/v1')
tree = mount({ inputActions: actions })
tree = act(() => triggerOf(tree).props.onClick())
eq(picks(tree).length, defaults.length, 'a never-set store seeds the panel')

/* ------------------------------------------------------------------ *
 * Network + teardown
 * ------------------------------------------------------------------ */

console.log('\n[ safety ]')
eq(networkCalls, 0, 'no network access during the whole run')
const styleTag = head.children.filter((el) => el.tagName === 'STYLE')[0]
disposers[0].disposer()
ok(styleTag.removed, 'unload removes the injected stylesheet')
eq(head.children.filter((el) => el.tagName === 'STYLE').length, 0, 'no orphan style tag left behind')

console.log(`\n${failures === 0 ? 'ALL GREEN' : 'FAILURES'}: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
