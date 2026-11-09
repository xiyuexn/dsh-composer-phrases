/**
 * Browser half of dsh-composer-phrases.
 *
 * A small capsule in the composer tool row (`conversation.input.left`, right
 * after the permission and plan controls). Clicking it opens a narrow vertical
 * panel: pick a saved phrase to write it into the composer at the caret, add new
 * ones, or delete ones you no longer want.
 *
 * Writing a phrase:
 *   1. `inputActions.captureInsertion()` takes the caret + draft revision,
 *   2. `inputActions.insertText(text, span)` inserts there, keeping whatever is
 *      already typed (returns false when the revision went stale — retried once),
 *   3. only as a last resort `inputActions.setDraft(...)` is used.
 *
 * Phrases live in this browser's localStorage. The plugin is local-only: no
 * service injection, no Cordis events, no model requests, no network, no
 * filesystem access. Its stylesheet is injected by apply() and removed by the
 * returned disposer, so unload leaves nothing behind.
 *
 * Hand-written in the shell's closure-factory format on purpose: the shell
 * resolves `react` from its own module table through the injected `require`, so
 * this package needs no build step.
 */
window.__ModuleLoader__.load({
	id: 'dsh-composer-phrases',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports

		const React = require('react')
		const h = React.createElement

		/** Plugin id; also the style-tag owner and the slot registrant name. */
		const PLUGIN_ID = 'dsh-composer-phrases'
		/** Seat: the composer tool row, immediately after the permission/plan cluster. */
		const SLOT = 'conversation.input.left'
		/** Ascending order within that list; the seat ships empty. */
		const SLOT_ORDER = 0
		const STORE_PHRASES = 'dsh-composer-phrases/phrases/v1'

		/** Seeded on first run so the panel is useful before it is ever edited. */
		const DEFAULT_PHRASES = [
			'继续',
			'先给我几个方案',
			'用大白话解释',
			'总结一下',
			'列出要改的文件',
			'先写测试',
		]

		/* ------------------------------------------------------------------ *
		 * Storage (localStorage only; every failure degrades to defaults)
		 * ------------------------------------------------------------------ */

		function storage() {
			try {
				return typeof localStorage === 'undefined' ? undefined : localStorage
			} catch {
				/* Blocked storage (private mode / policy): stay silent, run on defaults. */
				return undefined
			}
		}

		/**
		 * Read the saved phrases.
		 *
		 * The seed list is the *first-run* default only: an absent key or an
		 * unreadable value falls back to it, while an explicitly emptied list
		 * (the user deleted everything) stays empty and is respected.
		 */
		function readPhrases() {
			const store = storage()
			if (store === undefined) return DEFAULT_PHRASES.slice()
			try {
				const raw = store.getItem(STORE_PHRASES)
				if (raw === null) return DEFAULT_PHRASES.slice()
				const parsed = JSON.parse(raw)
				if (!Array.isArray(parsed)) return DEFAULT_PHRASES.slice()
				return normalizeLines(parsed.join('\n'))
			} catch {
				return DEFAULT_PHRASES.slice()
			}
		}

		/** Persist the phrase list; a quota/blocked failure keeps the in-memory list. */
		function writePhrases(list) {
			const store = storage()
			if (store === undefined) return
			try {
				store.setItem(STORE_PHRASES, JSON.stringify(list))
			} catch {
				/* Ignore: the session keeps working with the in-memory list. */
			}
		}

		/** One phrase per line, trimmed, blanks dropped, duplicates collapsed. */
		function normalizeLines(text) {
			const seen = new Set()
			const out = []
			for (const line of String(text).split(/\r?\n/)) {
				const value = line.trim()
				if (value === '' || seen.has(value)) continue
				seen.add(value)
				out.push(value)
			}
			return out
		}

		/* ------------------------------------------------------------------ *
		 * Component
		 * ------------------------------------------------------------------ */

		/**
		 * The composer-dock arrow and its panel.
		 *
		 * Props come from the owner, not from this plugin: the slot's standard
		 * props carry `inputActions` and `useInput` (exactly as they do for the
		 * shipped todo dock, which also registers without an inject face).
		 */
		function QuickPhrases(props) {
			const inputActions = props.inputActions
			const useInput = props.useInput
			// The seat guarantees useInput; the guard only keeps a future shell
			// change from throwing instead of degrading.
			const input = typeof useInput === 'function' ? useInput((state) => state) : undefined

			const [phrases, setPhrases] = React.useState(readPhrases)
			const [open, setOpen] = React.useState(false)
			const [entry, setEntry] = React.useState('')
			/** Last insert outcome worth telling the user; empty when nothing to say. */
			const [hint, setHint] = React.useState('')
			const rootRef = React.useRef(null)

			const phase = input === undefined || input === null ? undefined : input.phase
			const busy = phase === 'submitting' || phase === 'adjudicating'
			const draft = input !== undefined && input !== null && typeof input.draft === 'string' ? input.draft : undefined

			// Clicking anywhere outside the panel closes it; the listener exists
			// only while the panel is open and is removed with the effect.
			React.useEffect(() => {
				if (!open) return undefined
				const onPointerDown = (event) => {
					const root = rootRef.current
					const target = event === undefined || event === null ? undefined : event.target
					if (root !== null && root !== undefined && target !== undefined && typeof root.contains === 'function' && root.contains(target)) return
					setOpen(false)
				}
				document.addEventListener('mousedown', onPointerDown, true)
				return () => document.removeEventListener('mousedown', onPointerDown, true)
			}, [open])

			// A hint is transient: clear it a few seconds after it appears, and
			// drop the timer when another hint replaces it or the seat unmounts.
			React.useEffect(() => {
				if (hint === '') return undefined
				const timer = setTimeout(() => setHint(''), 4000)
				return () => clearTimeout(timer)
			}, [hint])

			/**
			 * Write one phrase into the composer, caret-first.
			 *
			 * The caret insert is the contract; the `setDraft` path is a last
			 * resort that loses the caret position, so it says so out loud
			 * instead of appending silently. A separator keeps the phrase from
			 * fusing with text that does not end in whitespace.
			 */
			const insertPhrase = (text) => {
				if (inputActions === undefined || inputActions === null) {
					setHint('输入框不可用')
					return
				}
				for (let attempt = 0; attempt < 2; attempt += 1) {
					const span = typeof inputActions.captureInsertion === 'function' ? inputActions.captureInsertion() : undefined
					if (span !== undefined && typeof inputActions.insertText === 'function' && inputActions.insertText(text, span) === true) {
						setHint('')
						return
					}
				}
				if (typeof inputActions.setDraft !== 'function') {
					setHint('插入失败')
					return
				}
				const base = draft === undefined ? '' : draft
				const sep = base === '' || /\s$/.test(base) ? '' : ' '
				inputActions.setDraft(base + sep + text)
				setHint('已追加到末尾')
			}

			const pick = (text) => {
				insertPhrase(text)
				setOpen(false)
			}

			const addPhrase = () => {
				const value = entry.trim()
				if (value === '') return
				setEntry('')
				if (phrases.includes(value)) return
				const next = [...phrases, value]
				writePhrases(next)
				setPhrases(next)
			}

			const removePhrase = (text) => {
				// Deleting the last phrase leaves an empty, still usable panel; the
				// seed list is never resurrected behind the user's back.
				const next = phrases.filter((phrase) => phrase !== text)
				writePhrases(next)
				setPhrases(next)
			}

			const panel = !open
				? null
				: h(
						'div',
						{ className: 'dsh-qp__panel', role: 'dialog', 'aria-label': '常用短语' },
						h('div', { className: 'dsh-qp__head' }, '常用短语'),
						h(
							'div',
							{ className: 'dsh-qp__list' },
							phrases.length === 0
								? h('div', { className: 'dsh-qp__empty' }, '还没有短语，在下面添加一条')
								: phrases.map((phrase) =>
								h(
									'div',
									{ key: phrase, className: 'dsh-qp__row' },
									h(
										'button',
										{
											type: 'button',
											className: 'dsh-qp__pick',
											title: busy ? `${phrase}（输入框正忙）` : `插入：${phrase}`,
											disabled: busy,
											onClick: () => pick(phrase),
										},
										phrase,
									),
									h(
										'button',
										{ type: 'button', className: 'dsh-qp__del', title: `删除：${phrase}`, onClick: () => removePhrase(phrase) },
										'×',
									),
								),
							),
						),
						h(
							'div',
							{ className: 'dsh-qp__add' },
							h('input', {
								className: 'dsh-qp__input',
								value: entry,
								placeholder: '添加一条…',
								spellCheck: false,
								onChange: (event) => setEntry(event.target.value),
								onKeyDown: (event) => {
									if (event.key !== 'Enter') return
									event.preventDefault()
									addPhrase()
								},
							}),
							h('button', { type: 'button', className: 'dsh-qp__addBtn', onClick: addPhrase }, '添加'),
						),
					)

			return h(
				'div',
				{ className: 'dsh-qp', ref: rootRef, 'data-plugin': PLUGIN_ID },
				panel,
				h(
					'button',
					{
						type: 'button',
						className: 'dsh-qp__trigger',
						title: open ? '收起常用短语' : '常用短语',
						'aria-expanded': open ? 'true' : 'false',
						onClick: () => setOpen(!open),
					},
					// While a notice is up, the pill itself carries it: a label
					// inside the button cannot be clipped by the card, and it
					// overlays nothing to its right.
					hint !== '' ? hint : open ? '短语 ▾' : '短语 ▴',
				),
				// Rendered only when there is something to say, so the tool row
				// keeps its width in the normal case.
				hint === '' ? null : h('span', { className: 'dsh-qp__hint', role: 'status', 'aria-live': 'polite' }, hint),
			)
		}

		/* ------------------------------------------------------------------ *
		 * Styles — scoped to .dsh-qp, themed through the shell's tokens so the
		 * panel follows light/dark and every installed skin.
		 * ------------------------------------------------------------------ */

		const CSS = `
.dsh-qp {
	position: relative;
	display: inline-flex;
	align-items: center;
	font-size: 12px;
	line-height: 1.5;
	color: var(--dsw-alias-label-secondary);
}
.dsh-qp__trigger {
	position: relative;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	height: 20px;
	padding: 0 8px;
	cursor: pointer;
	font: inherit;
	font-size: 11px;
	line-height: 1;
	white-space: nowrap;
	color: var(--dsw-alias-label-secondary);
	background: var(--dsw-alias-bg-layer-2);
	border: 1px solid var(--dsw-alias-border-l2);
	border-radius: 6px;
}
/* The visible pill stays 20px tall so the tool row keeps its density, but the
   touch target does not: an invisible ::before extends the hit area to about
   36px, and a coarse pointer (touch) gets a taller, wider pill as well. */
.dsh-qp__trigger::before {
	content: '';
	position: absolute;
	inset: -8px -4px;
}
/* The notice is carried by the pill's own label, so it can never be clipped by
   the card or the conversation container. This node only hands the same text to
   assistive tech and is visually hidden. */
.dsh-qp__hint {
	position: absolute;
	width: 1px;
	height: 1px;
	padding: 0;
	margin: -1px;
	overflow: hidden;
	clip: rect(0, 0, 0, 0);
	white-space: nowrap;
	border: 0;
}
@media (pointer: coarse) {
	.dsh-qp__trigger {
		height: 28px;
		min-width: 44px;
		padding: 0 10px;
		font-size: 12px;
	}
}

.dsh-qp__trigger:hover {
	color: var(--dsw-alias-label-primary);
	border-color: var(--dsw-alias-brand-primary);
}
.dsh-qp__trigger:focus-visible {
	outline: 2px solid var(--dsw-alias-brand-primary);
	outline-offset: 1px;
}
.dsh-qp__panel {
	position: absolute;
	left: 0;
	bottom: calc(100% + 6px);
	z-index: 90;
	box-sizing: border-box;
	display: flex;
	flex-direction: column;
	width: 232px;
	max-height: 264px;
	padding: 8px;
	color: var(--dsw-alias-label-primary);
	background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1));
	border: 1px solid var(--dsw-alias-border-l2);
	border-radius: 10px;
	box-shadow: var(--dsw-shadow-lv2, 0 12px 32px rgba(0, 0, 0, 0.18));
}
.dsh-qp__head {
	flex: none;
	padding: 0 2px 6px;
	font-size: 11px;
	letter-spacing: 0.06em;
	color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
}
.dsh-qp__list {
	flex: 1 1 auto;
	min-height: 0;
	display: flex;
	flex-direction: column;
	gap: 2px;
	overflow-y: auto;
}
.dsh-qp__row {
	display: flex;
	align-items: center;
	gap: 2px;
}
.dsh-qp__empty {
	padding: 6px 8px;
	font-size: 12px;
	color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
}
.dsh-qp__pick {
	flex: 1 1 auto;
	min-width: 0;
	padding: 4px 8px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	text-align: left;
	cursor: pointer;
	font: inherit;
	font-size: 12px;
	color: var(--dsw-alias-label-secondary);
	background: transparent;
	border: 1px solid transparent;
	border-radius: 6px;
}
.dsh-qp__pick:hover:not(:disabled) {
	color: var(--dsw-alias-label-primary);
	background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
}
.dsh-qp__pick:disabled {
	opacity: 0.5;
	cursor: default;
}
.dsh-qp__pick:focus-visible,
.dsh-qp__del:focus-visible,
.dsh-qp__addBtn:focus-visible {
	outline: 2px solid var(--dsw-alias-brand-primary);
	outline-offset: 1px;
}
.dsh-qp__del {
	flex: none;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 20px;
	height: 20px;
	padding: 0;
	cursor: pointer;
	font: inherit;
	font-size: 12px;
	line-height: 1;
	color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
	background: transparent;
	border: 1px solid transparent;
	border-radius: 6px;
}
.dsh-qp__del:hover {
	color: var(--dsw-alias-label-primary);
	border-color: var(--dsw-alias-border-l2);
}
.dsh-qp__add {
	flex: none;
	display: flex;
	gap: 6px;
	margin-top: 6px;
	padding-top: 8px;
	border-top: 1px solid var(--dsw-alias-border-l1, var(--dsw-alias-border-l2));
}
.dsh-qp__input {
	flex: 1 1 auto;
	min-width: 0;
	box-sizing: border-box;
	padding: 4px 8px;
	font: inherit;
	font-size: 12px;
	color: var(--dsw-alias-label-primary);
	background: var(--dsw-alias-bg-layer-2);
	border: 1px solid var(--dsw-alias-border-l2);
	border-radius: 6px;
}
.dsh-qp__input:focus-visible {
	outline: none;
	border-color: var(--dsw-alias-brand-primary);
}
.dsh-qp__addBtn {
	flex: none;
	padding: 4px 10px;
	cursor: pointer;
	font: inherit;
	font-size: 12px;
	color: var(--dsw-alias-label-primary);
	background: var(--dsw-alias-bg-layer-2);
	border: 1px solid var(--dsw-alias-border-l2);
	border-radius: 6px;
}
.dsh-qp__addBtn:hover {
	border-color: var(--dsw-alias-brand-primary);
}
`

		/* ------------------------------------------------------------------ *
		 * Plugin apply
		 * ------------------------------------------------------------------ */

		/** Cordis service this plugin needs: the slot registry. */
		const inject = ['slots']

		/**
		 * Inject the stylesheet and take the composer-dock seat.
		 * @param ctx - client Context carrying the `slots` service.
		 */
		function apply(ctx) {
			if (typeof document !== 'undefined') {
				const tagId = `${PLUGIN_ID}/phrases.css`
				const owned = document.createElement('style')
				owned.dataset.plugin = PLUGIN_ID
				owned.dataset.pluginCss = tagId
				owned.textContent = CSS
				document.head.appendChild(owned)
				// Registered before any fallible work is done below, so a later
				// failure still cannot strand the tag in the document.
				ctx.effect(() => () => owned.remove(), `${PLUGIN_ID}: stylesheet`)
			}
			ctx.slots.inject(SLOT, () =>
				ctx.slots.register({ name: SLOT, id: 'composer-phrases', order: SLOT_ORDER }, QuickPhrases),
			)
		}

		exports.QuickPhrases = QuickPhrases
		exports.apply = apply
		exports.inject = inject
		return module.exports
	},
})
