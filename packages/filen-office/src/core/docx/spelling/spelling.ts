import { spliceAll } from "../../arrays"
import type { Node } from "prosemirror-model"
import type { EditorState, Transaction } from "prosemirror-state"
import type { Mapping } from "prosemirror-transform"
import type { DocxEditorSession } from "../edit/session"
import { docxSchema } from "../edit/schema"
import type { SpellingChecker, SpellingIssue, SpellingMark, SpellingSuggestOptions } from "./checker"
import { ParagraphScanner, inWordStyle, spellingQuery } from "./scan"

// Spelling of one editing session, headless: the issues of the document (misspelled and repeated words)
// as ranges for a view to mark, kept in step with every edit, and the actions on them (suggestions,
// replace, ignore all, add to dictionary). Edits move the existing marks at once, in place, and leave the
// ranges they changed to check (moved through later edits); after a short pause a pass checks those ranges
// within a time budget and nothing else. Once nothing is left to check no pass runs. The word being typed is
// not marked until the caret leaves it. Nothing here touches the DOM.

export interface DocxSpellingOptions {
	// Language for text whose runs and styles name none (the app's editing language).
	readonly defaultLanguage?: string
	// Word's proofing options, on by default.
	readonly ignoreUppercase?: boolean
	readonly ignoreWordsWithNumbers?: boolean
	readonly ignoreAddresses?: boolean
	readonly flagRepeated?: boolean
	// Pause after an edit before the document is checked again (ms).
	readonly delayMs?: number
	// Time one pass may spend scanning paragraphs before it yields (ms).
	readonly budgetMs?: number
	readonly now?: () => number
	readonly timers?: SpellingTimers
}

export interface SpellingTimers {
	set(callback: () => void, ms: number): unknown
	clear(handle: unknown): void
}

const DELAY_MS = 300
const BUDGET_MS = 8
// Marks kept per document (in document order). A text in the wrong language would otherwise be marked
// word by word, and every keystroke maps and redraws every mark.
export const MAX_SPELLING_ISSUES = 10_000
const NO_MARKS: readonly SpellingMark[] = Object.freeze([])

// An issue as kept here: its place moves with edits.
type MovableIssue = Omit<SpellingIssue, "from" | "to"> & { from: number; to: number }

function defaultNow(): () => number {
	const performance: unknown = Reflect.get(globalThis, "performance")
	const now: unknown = typeof performance === "object" && performance !== null ? Reflect.get(performance, "now") : undefined

	return typeof now === "function" ? () => (now as () => number).call(performance) : Date.now
}

function defaultTimers(): SpellingTimers {
	const set: unknown = Reflect.get(globalThis, "setTimeout")
	const clear: unknown = Reflect.get(globalThis, "clearTimeout")

	if (typeof set !== "function" || typeof clear !== "function") throw new Error("No timers: pass DocxSpellingOptions.timers")

	return {
		set: (callback, ms) => (set as (callback: () => void, ms: number) => unknown)(callback, ms),
		clear: handle => (clear as (handle: unknown) => void)(handle)
	}
}

// Ranges ([from, to) pairs, ascending, apart) moved through an edit; those it emptied go.
function mapRanges(ranges: readonly number[], mapping: Mapping): number[] {
	const out: number[] = []

	for (let k = 0; k + 1 < ranges.length; k += 2) {
		const from = mapping.map(ranges[k] ?? 0, -1)
		const to = mapping.map(ranges[k + 1] ?? 0, 1)

		if (to > from) out.push(from, to)
	}

	return out
}

// Ranges closer than this are kept as one (the paragraphs of a table, a few positions apart, are one range).
const RANGE_SLACK = 8

// Two lists of ranges as one (ranges overlapping or closer than RANGE_SLACK merged), in one pass.
function mergeRanges(a: readonly number[], b: readonly number[]): number[] {
	const out: number[] = []
	let i = 0
	let j = 0

	while (i + 1 < a.length || j + 1 < b.length) {
		const fromA = i + 1 < a.length && (j + 1 >= b.length || (a[i] ?? 0) <= (b[j] ?? 0))
		const from = (fromA ? a[i] : b[j]) ?? 0
		const to = (fromA ? a[i + 1] : b[j + 1]) ?? 0

		if (fromA) i += 2
		else j += 2

		if (to <= from) continue

		if (out.length > 0 && from <= (out[out.length - 1] ?? 0) + RANGE_SLACK) out[out.length - 1] = Math.max(out[out.length - 1] ?? 0, to)
		else out.push(from, to)
	}

	return out
}

// `ranges` with [from, to) added.
function addRange(ranges: readonly number[], from: number, to: number): number[] {
	return mergeRanges(ranges, [from, to])
}

// The one replaced range of a mapping of one step (typing, a deletion): its start and end before the edit
// and how far it moved what followed; undefined for any other mapping.
function singleEdit(mapping: Mapping): { start: number; end: number; shift: number } | undefined {
	if (mapping.maps.length !== 1) return undefined

	let edit: { start: number; end: number; shift: number } | undefined
	let ranges = 0

	mapping.maps[0]?.forEach((oldStart, oldEnd, newStart, newEnd) => {
		ranges++
		edit = { start: oldStart, end: oldEnd, shift: newEnd - newStart - (oldEnd - oldStart) }
	})

	return ranges === 1 ? edit : undefined
}

// The first issue (in document order) whose end is at or after `pos`.
function firstEndingFrom(issues: readonly SpellingIssue[], pos: number): number {
	let low = 0
	let high = issues.length

	while (low < high) {
		const middle = (low + high) >> 1

		if ((issues[middle]?.to ?? 0) < pos) low = middle + 1
		else high = middle
	}

	return low
}

// The range [from, to] of the document `mapping` produced that its steps changed, or undefined.
function changedRange(mapping: Mapping): { from: number; to: number } | undefined {
	let from = Number.POSITIVE_INFINITY
	let to = Number.NEGATIVE_INFINITY
	const maps = mapping.maps

	maps.forEach((map, index) => {
		map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
			let start = newStart
			let end = newEnd

			for (let i = index + 1; i < maps.length; i++) {
				start = maps[i]?.map(start, -1) ?? start
				end = maps[i]?.map(end, 1) ?? end
			}

			from = Math.min(from, start)
			to = Math.max(to, end)
		})
	})

	return from <= to ? { from, to } : undefined
}

export class DocxSpelling {
	// The document asks for spelling errors not to be shown (w:hideSpellingErrors): nothing is checked.
	readonly hidden: boolean
	private readonly session: DocxEditorSession
	private readonly checker: SpellingChecker
	private readonly scanner: ParagraphScanner
	private readonly delay: number
	private readonly budget: number
	private readonly now: () => number
	private readonly timers: SpellingTimers
	private readonly listeners = new Set<(marks: readonly SpellingMark[]) => void>()
	private readonly unsubscribe: (() => void)[] = []
	// Ranges still to check ([from, to) pairs, ascending, apart), and those of paragraphs waiting for verdicts:
	// both moved through edits.
	private dirty: number[] = []
	private waiting: number[] = []
	// Issues past MAX_SPELLING_ISSUES were dropped: the rest of the document is checked again once there is room.
	private capped = false
	// Words asked for since the last edit or notice, by dictionary: never asked twice, so a checker that
	// answers without a verdict cannot start a loop.
	private requested = new Map<string, Set<string>>()
	// Dictionaries whose check failed (not loadable): not asked again until the next edit or notice.
	private readonly failed = new Set<string>()
	// In document order. Moved in place by edits (an issue keeps its identity while it stays), so a keystroke
	// allocates no issue; marks() is a new array whenever marks came, went or changed length, and the same
	// array (its marks moved) when an edit only moved them.
	private issues: MovableIssue[] = []
	private readonly ignored = new Set<string>()
	private readonly ignoredRepeats = new Set<string>()
	// The last edit and the issue it is typing (not marked while the caret is in it).
	private lastEdit: { from: number; to: number } | undefined = undefined
	private suppressed: SpellingIssue | undefined = undefined
	private marksValue: readonly SpellingMark[] = NO_MARKS
	private timer: unknown = undefined
	private timerDue = Number.POSITIVE_INFINITY
	private disposed = false

	constructor(session: DocxEditorSession, checker: SpellingChecker, options: DocxSpellingOptions = {}) {
		this.session = session
		this.checker = checker
		this.hidden = session.context.model.settings.hideSpellingErrors
		this.delay = options.delayMs ?? DELAY_MS
		this.budget = options.budgetMs ?? BUDGET_MS
		this.now = options.now ?? defaultNow()
		this.timers = options.timers ?? defaultTimers()
		this.scanner = new ParagraphScanner(session.context, session.story.part, checker, {
			defaultLanguage: options.defaultLanguage,
			ignoreUppercase: options.ignoreUppercase ?? true,
			ignoreWordsWithNumbers: options.ignoreWordsWithNumbers ?? true,
			ignoreAddresses: options.ignoreAddresses ?? true,
			flagRepeated: options.flagRepeated ?? true
		})

		if (this.hidden) return

		this.unsubscribe.push(
			session.onApplied((transactions, state) => this.onApplied(transactions, state)),
			checker.subscribe(() => this.invalidate())
		)
		this.dirty = [0, session.state.doc.content.size]
		this.schedule(0)
	}

	// Ranges to mark now, in document order (empty while the document hides spelling errors). An edit that
	// only moves marks moves them in this array: a view redraws them with the document it shows.
	marks(): readonly SpellingMark[] {
		return this.marksValue
	}

	// Hears every new marks() (synchronously after the edit or pass that made it).
	subscribe(listener: (marks: readonly SpellingMark[]) => void): () => void {
		this.listeners.add(listener)

		return () => {
			this.listeners.delete(listener)
		}
	}

	dispose(): void {
		this.disposed = true
		this.cancel()

		for (const stop of this.unsubscribe) stop()

		this.unsubscribe.length = 0
		this.listeners.clear()
	}

	// The issue at a document position (inside the word or at either end), the one being typed included.
	spellingAt(pos: number): SpellingIssue | undefined {
		const issues = this.issues
		let low = 0
		let high = issues.length

		while (low < high) {
			const middle = (low + high) >> 1

			if ((issues[middle]?.to ?? 0) < pos) low = middle + 1
			else high = middle
		}

		const issue = issues[low]

		return issue !== undefined && issue.from <= pos && pos <= issue.to && this.current(issue) ? issue : undefined
	}

	// Corrections for the misspelled word at `pos`, best first: the fast pass, and the full one when that
	// finds nothing or `more` asks for it. A repeated word has none (its fix is deleting it).
	async suggestions(pos: number, options: SpellingSuggestOptions = {}): Promise<readonly string[]> {
		const issue = this.spellingAt(pos)

		if (issue === undefined || issue.kind !== "spelling") return []

		const query = spellingQuery(issue.word)
		const fast = options.more === true ? [] : await this.checker.suggest(issue.dictionary, query, { more: false })

		return inWordStyle(issue.word, fast.length > 0 ? fast : await this.checker.suggest(issue.dictionary, query, { more: true }))
	}

	// Replaces the word at `pos` (keeping its formatting); "" for a repeated word deletes it with the space
	// before it. False when there is no issue there or the session refused the edit (read-only).
	replaceWord(pos: number, replacement: string): boolean {
		const issue = this.spellingAt(pos)

		if (issue === undefined) return false

		const state = this.session.state
		let tr: Transaction

		if (replacement === "") {
			const $from = state.doc.resolve(issue.from)
			const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 32), $from.parentOffset, undefined, "￼")
			const spaces = before.length - before.trimEnd().length

			tr = state.tr.delete(issue.from - spaces, issue.to)
		} else {
			tr = state.tr.insertText(replacement, issue.from, issue.to)
		}

		return this.session.dispatch(tr.scrollIntoView())
	}

	// Stops marking this word (a repeated word: stops flagging its repetitions) for the rest of the session.
	ignoreAll(pos: number): boolean {
		const issue = this.spellingAt(pos)

		if (issue === undefined) return false

		if (issue.kind === "repeated") this.ignoredRepeats.add(issue.word.toLowerCase())
		else this.ignored.add(spellingQuery(issue.word))

		this.invalidate()

		return true
	}

	// Adds the word at `pos` to the user's dictionary; the checker's change notice re-checks the document.
	async addToDictionary(pos: number): Promise<boolean> {
		const issue = this.spellingAt(pos)

		if (issue?.kind !== "spelling") return false

		await this.checker.addToDictionary(spellingQuery(issue.word))

		return true
	}

	// ---- internals --------------------------------------------------------------------------------------

	// Whether a mapped issue still covers its word (an edit since the last pass may have changed it).
	private current(issue: SpellingIssue): boolean {
		const doc = this.session.state.doc

		if (issue.to > doc.content.size) return false

		return doc.textBetween(issue.from, issue.to, undefined, "￼").replace(/[­￼]/g, "") === issue.word
	}

	private onApplied(transactions: readonly Transaction[], state: EditorState): void {
		let changed = false
		let marksChanged = false

		for (const tr of transactions) {
			if (!tr.docChanged) continue

			const range = changedRange(tr.mapping)

			changed = true
			marksChanged = this.mapIssues(this.issues, tr.mapping, this.suppressed) || marksChanged
			this.dirty = mapRanges(this.dirty, tr.mapping)
			this.waiting = mapRanges(this.waiting, tr.mapping)
			this.lastEdit = range ?? this.lastEdit

			// The paragraphs around it too: an edit at a paragraph's edge joins or splits paragraphs.
			if (range !== undefined)
				this.dirty = addRange(this.dirty, Math.max(0, range.from - 1), Math.min(tr.doc.content.size, range.to + 1))
		}

		if (changed) {
			this.retry()
			this.schedule(this.delay)
		}

		this.emit(state, marksChanged)
	}

	// Moves the issues through an edit, in place; those it deleted go. Whether any marked one went or changed
	// length (a view needs a new list then; moved marks only need drawing again); the issue being typed is not
	// marked (`unmarked`).
	private mapIssues(issues: MovableIssue[], mapping: Mapping, unmarked: SpellingIssue | undefined): boolean {
		const count = issues.length
		const edit = singleEdit(mapping)
		// Issues ending before the edit stay; those starting after it move by its size (most of a document,
		// mapped without a lookup each).
		let kept = edit === undefined ? 0 : firstEndingFrom(issues, edit.start + 1)
		let changed = false

		// Indexed: the array is compacted as it is read.
		for (let k = kept; k < count; k++) {
			const issue = issues[k]

			if (issue === undefined) continue

			if (edit !== undefined && issue.from > edit.end) {
				issue.from += edit.shift
				issue.to += edit.shift
				issues[kept++] = issue

				continue
			}

			const from = mapping.map(issue.from, 1)
			const to = mapping.map(issue.to, -1)

			if (to <= from) {
				changed ||= issue !== unmarked

				continue
			}

			if (to - from !== issue.to - issue.from && issue !== unmarked) changed = true

			issue.from = from
			issue.to = to
			issues[kept++] = issue
		}

		issues.length = kept

		return changed
	}

	// Verdicts may have changed (the user's words, words ignored): the whole document is checked again.
	private invalidate(): void {
		this.waiting = []
		this.dirty = [0, this.session.state.doc.content.size]
		this.retry()
		this.schedule(0)
	}

	// Unchecked words and failed dictionaries get asked for again: paragraphs waiting for verdicts are checked
	// again (none are once every word has one).
	private retry(): void {
		this.requested = new Map()
		this.failed.clear()
		this.recheckWaiting()
	}

	// Paragraphs waiting for verdicts are checked again (verdicts came, or their dictionary is tried again).
	private recheckWaiting(): void {
		this.dirty = mergeRanges(this.dirty, this.waiting)
		this.waiting = []
	}

	private schedule(ms: number): void {
		if (this.disposed || this.hidden) return

		const due = this.now() + ms

		// An earlier pass already due covers this request, unless this one asks for a later one (an edit).
		if (this.timer !== undefined && due <= this.timerDue && ms === 0) return

		this.cancel()
		this.timerDue = due
		this.timer = this.timers.set(() => {
			this.timer = undefined
			this.timerDue = Number.POSITIVE_INFINITY
			this.pass()
		}, ms)
	}

	private cancel(): void {
		if (this.timer !== undefined) this.timers.clear(this.timer)

		this.timer = undefined
		this.timerDue = Number.POSITIVE_INFINITY
	}

	// One pass over what is left to check, in document order: its paragraphs are scanned within the time budget
	// (the rest stays to check, and the next pass continues there); words never asked for go to the checker,
	// whose answer checks the paragraphs waiting for it again. Nothing is kept per paragraph: an edit leaves
	// only its own paragraphs to check.
	private pass(): void {
		if (this.disposed) return

		const state = this.session.state
		const doc = state.doc
		const size = doc.content.size
		const deadline = this.now() + this.budget
		const unknown = new Map<string, Set<string>>()
		// Paragraphs found waiting for verdicts, in order (runs of them as one range).
		const waiting: number[] = []
		let scanned = 0
		let changed = false
		let stopped = false

		while (this.dirty.length >= 2 && !stopped) {
			const from = Math.min(this.dirty[0] ?? 0, size)
			const to = Math.min(this.dirty[1] ?? 0, size)

			// Issues before the range stay: from it on, issues are taken up to the limit only (the rest is checked
			// once there is room).
			const room = MAX_SPELLING_ISSUES - firstEndingFrom(this.issues, from + 1)
			let full = false
			// The paragraphs checked ([start, end) of the first and last) and their issues, in order.
			let start = -1
			let end = from
			const found: MovableIssue[] = []
			const visit = (node: Node, pos: number): boolean => {
				if (stopped || full) return false

				if (found.length >= room) {
					full = true

					return false
				}

				if (node.type !== docxSchema.nodes.paragraph) return node.type !== docxSchema.nodes.locked_block

				// At least one paragraph per pass, so a pass always makes progress.
				if (scanned > 0 && this.now() > deadline) {
					stopped = true

					return false
				}

				const scan = this.scanner.scan(node, this.ignored, this.ignoredRepeats, unknown)

				scanned++

				if (start < 0) start = pos

				end = pos + node.nodeSize

				// Words without verdicts: checked again once they come (shown as they are meanwhile).
				if (!scan.complete) {
					if (waiting.length > 0 && pos <= (waiting[waiting.length - 1] ?? 0) + RANGE_SLACK) waiting[waiting.length - 1] = end
					else waiting.push(pos, end)
				}

				for (const issue of scan.issues) found.push({ ...issue, from: issue.from + pos + 1, to: issue.to + pos + 1 })

				return false
			}

			doc.nodesBetween(from, Math.max(from, to), visit)

			if (start >= 0) changed = this.replaceIssues(start, end, found) || changed

			if (full) {
				// What follows is past the limit too (ranges are in order).
				this.capped = true
				this.dirty = []

				break
			}

			// What is left of the range: past the last paragraph checked when the budget ran out.
			this.dirty = stopped ? [Math.max(from, end), ...this.dirty.slice(1)] : this.dirty.slice(2)

			if (stopped && (this.dirty[0] ?? 0) >= (this.dirty[1] ?? 0)) this.dirty = this.dirty.slice(2)
		}

		// Room again below the limit: the rest of the document is checked for the issues dropped.
		if (this.capped && this.issues.length < MAX_SPELLING_ISSUES) {
			this.capped = false
			this.dirty = addRange(this.dirty, this.issues[this.issues.length - 1]?.to ?? 0, size)
		}

		this.waiting = mergeRanges(this.waiting, waiting)
		this.ask(unknown)

		if (this.dirty.length > 0) this.schedule(0)

		this.emit(state, changed)
	}

	// Replaces the issues of the paragraphs in [start, end) with `found` (in order), keeping each that is the
	// same as before (place, word and verdict): a pass that finds what was there allocates nothing for it.
	// Whether anything changed.
	private replaceIssues(start: number, end: number, found: MovableIssue[]): boolean {
		const issues = this.issues
		const low = firstEndingFrom(issues, start + 1)
		let high = low

		while (high < issues.length && (issues[high]?.from ?? 0) < end) high++

		let same = high - low === found.length

		for (let k = 0; k < found.length; k++) {
			const old = issues[low + k]
			const issue = found[k]

			if (
				old !== undefined &&
				low + k < high &&
				issue !== undefined &&
				old.from === issue.from &&
				old.to === issue.to &&
				old.kind === issue.kind &&
				old.word === issue.word &&
				old.dictionary === issue.dictionary &&
				old.language === issue.language
			) {
				found[k] = old
			} else {
				same = false
			}
		}

		if (same) return false

		spliceAll(issues, low, high - low, found)

		if (issues.length > MAX_SPELLING_ISSUES) {
			issues.length = MAX_SPELLING_ISSUES
			this.capped = true
		}

		return true
	}

	// Sends the words without a verdict to the checker, each once until the next edit or notice.
	private ask(unknown: Map<string, Set<string>>): void {
		for (const [dictionary, words] of unknown) {
			if (this.failed.has(dictionary)) continue

			let asked = this.requested.get(dictionary)

			if (asked === undefined) {
				asked = new Set()
				this.requested.set(dictionary, asked)
			}

			const fresh: string[] = []

			for (const word of words) {
				if (!asked.has(word)) {
					asked.add(word)
					fresh.push(word)
				}
			}

			if (fresh.length === 0) continue

			const requested = this.requested

			this.checker.check(dictionary, fresh).then(
				() => {
					if (this.disposed) return

					this.recheckWaiting()
					this.schedule(0)
				},
				() => {
					if (requested === this.requested) this.failed.add(dictionary)
				}
			)
		}
	}

	// Recomputes the issue being typed and publishes marks when they changed.
	private emit(state: EditorState, issuesChanged: boolean): void {
		const selection = state.selection
		let suppressed: SpellingIssue | undefined

		if (selection.empty && this.lastEdit !== undefined) {
			const caret = selection.head
			const edit = this.lastEdit

			// An insertion inside or at the end of the word, or a deletion within it (an edit that only touches
			// the word's start, like typing before it, is not typing it).
			const typed = (issue: SpellingIssue): boolean =>
				edit.from === edit.to ? issue.from <= edit.from && edit.from <= issue.to : edit.from < issue.to && issue.from < edit.to

			// The first issue ending at or after the caret, and the one after it (both may touch the caret).
			const first = firstEndingFrom(this.issues, caret)

			for (let k = first; k < first + 2 && suppressed === undefined; k++) {
				const issue = this.issues[k]

				if (issue !== undefined && issue.from <= caret && caret <= issue.to && typed(issue)) suppressed = issue
			}

			// The caret left the edited word: later visits to it are not typing.
			if (suppressed === undefined && (caret < edit.from - 1 || caret > edit.to + 1)) this.lastEdit = undefined
		}

		if (!issuesChanged && suppressed === this.suppressed) return

		this.suppressed = suppressed

		// A new array: the issues move in place.
		const at = suppressed === undefined ? -1 : this.issues.indexOf(suppressed)

		this.marksValue = at < 0 ? this.issues.slice() : this.issues.slice(0, at).concat(this.issues.slice(at + 1))

		for (const listener of [...this.listeners]) listener(this.marksValue)
	}
}
