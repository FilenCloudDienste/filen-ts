import type { Dirt, Inverse, Touch } from "./apply"
import type { DeckOp } from "./ops"

// The deck's undo history: one timeline of applied steps (`entries[0..cursor)`) and redoable ones
// (`entries[cursor..)`), each with its op as applied, its inverse, and what it touched with a fingerprint of every
// touched thing before and after it. Bounded by bytes and by steps (the oldest step goes first); a typing burst
// coalesces into one step.
//
// Dirtiness is recomputed, never accumulated: the saved state is an anchor in the timeline, and a touched key is
// dirty when its fingerprint now differs from its fingerprint at the anchor, derived from the steps between the two
// (before the first one when the anchor is behind, after the last one when it is ahead). So an op followed by its
// inverse cancels out, and an undo back to the saved state is clean. When steps between the anchor and now leave
// the timeline (trimmed from the bottom, or a redo branch discarded by a new op), their saved fingerprints are kept
// in the anchor's baseline, so a different state at the same position never looks saved. Kept incrementally: each
// step updates only the keys it touched.
//
// The net bytes dirty (the autosave tiers' threshold) are estimated as the ops and inverses of the steps between the
// anchor and now that still leave one of their keys dirty, plus those of the steps that left the timeline into the
// baseline while one of their keys is dirty. Kept as a running total (each step counts its dirty keys), so reading it
// is O(1) and a change costs only the keys that flipped.

// A key's state: a stable digest of the model values it covers; `part` is the part it lives in (a slide's), so a
// removed slide still names its part. `exists` false: the thing is absent.
export interface Fingerprint {
	readonly digest: string
	readonly exists: boolean
	readonly part?: string
	// A sibling order's ids (back to front), so the moved shapes can be told.
	readonly order?: readonly number[]
}

// Keys whose state cannot be read back from the model compare unequal to anything (dirty while in range).
export const UNKNOWN_FINGERPRINT: Fingerprint = { digest: "\u0000unknown", exists: true }

export type TouchKey = string

export interface HistoryStep {
	readonly id: number
	op: DeckOp
	inverse: Inverse
	// What it touched (the page's change events).
	touches: readonly Touch[]
	// Every key it changed, with its fingerprint before and after (the same keys): a touch's key, the keys under a
	// whole node, and the sibling orders it changed.
	readonly before: ReadonlyMap<TouchKey, Fingerprint>
	after: ReadonlyMap<TouchKey, Fingerprint>
	bytes: number
	// A typing burst's identity (family, target, burst id): later transactions of the same burst coalesce.
	readonly burst: string | undefined
	// An op the step applies before `op` on a redo: what a step it continues made (the notes slide its text is in).
	readonly lead?: DeckOp
	// The history's own: the step as the dirty total counts it.
	counted?: StepCount | undefined
}

export interface HistoryLimits {
	readonly maxBytes: number
	readonly maxSteps: number
}

export const DECK_HISTORY_LIMITS: HistoryLimits = { maxBytes: 64 * 1024 * 1024, maxSteps: 500 }

// The fingerprint of a key in the model now.
export type FingerprintOf = (key: TouchKey) => Fingerprint

// A position in the timeline (after `pos` steps of `entries`) and the saved fingerprints of keys whose steps left it.
interface Anchor {
	pos: number
	readonly baseline: Map<TouchKey, Fingerprint>
	// The steps whose fingerprints went into the baseline, counted as one: their bytes and their keys.
	readonly lost: Counted
}

// A save in flight: the state it serializes, made the saved state when the save commits.
export interface SavePoint {
	readonly revision: number
}

function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
	return a !== UNKNOWN_FINGERPRINT && b !== UNKNOWN_FINGERPRINT && a.exists === b.exists && a.digest === b.digest
}

let nextId = 1

// An anchor as it was before the last push changed it: its scalars, and the keys the push added to its baseline and
// lost keys (a push only adds to them), so taking the push back costs what it changed, not the baseline's size.
interface AnchorCopy {
	readonly pos: number
	readonly baselineAdded: TouchKey[]
	readonly lost: { readonly bytes: number; readonly keysAdded: TouchKey[]; readonly dirty: number }
}

// What a push did besides adding its step (the redo branch it discarded, the oldest steps it trimmed, the anchors it
// moved), kept for the last push only, so retract() can put the history back exactly as it was before it.
interface PushRecord {
	redo: HistoryStep[]
	trimmed: HistoryStep[]
	readonly anchors: Map<Anchor, AnchorCopy>
	readonly saved: Anchor
	readonly savedReachable: boolean
	step?: HistoryStep
	revision?: number
	// The step makes nothing the user sees yet (notes started, nothing typed): not dirty on its own, left out of a save.
	provisional: boolean
}

// A step's bytes as the dirty total counts them, its keys, and how many of them are dirty now.
export interface StepCount extends Counted {
	// Counted in the total now (the step is in the saved anchor's range).
	live: boolean
}

interface Counted {
	bytes: number
	readonly keys: { keys(): Iterable<TouchKey> }
	dirty: number
}

function noneLost(): Counted {
	return { bytes: 0, keys: new Set<TouchKey>(), dirty: 0 }
}

function stepCount(step: HistoryStep): StepCount {
	return { bytes: opBytesOf(step.op) + step.inverse.bytes, keys: step.before, dirty: 0, live: false }
}

export class DeckHistory {
	readonly limits: HistoryLimits
	// Bumps on every applied step, undo and redo (the page's change events).
	revision = 0
	private readonly entries: HistoryStep[] = []
	private cursor = 0
	private bytes = 0
	private saved: Anchor = { pos: 0, baseline: new Map(), lost: noneLost() }
	// Whether the saved anchor is a step of the timeline (false once its branch was discarded or trimmed away).
	private savedReachable = true
	private readonly pending = new Map<SavePoint, Anchor>()
	// The saved anchor's derived fingerprints and how many steps in range touch each key.
	private readonly savedValue = new Map<TouchKey, Fingerprint>()
	private readonly inRange = new Map<TouchKey, number>()
	private readonly dirtyKeys = new Set<TouchKey>()
	// The counted steps of the saved anchor's range and baseline by key, the range's by step, and their dirty total.
	private readonly countedByKey = new Map<TouchKey, Set<Counted>>()
	private dirtyTotal = 0
	private readonly fingerprint: FingerprintOf
	// The push in progress and the last push, while nothing but saves came after it.
	private recording: PushRecord | undefined
	private lastPush: PushRecord | undefined

	constructor(fingerprint: FingerprintOf, limits: HistoryLimits = DECK_HISTORY_LIMITS) {
		this.fingerprint = fingerprint
		this.limits = limits
	}

	get canUndo(): boolean {
		return this.cursor > 0
	}

	get canRedo(): boolean {
		return this.cursor < this.entries.length
	}

	get dirty(): boolean {
		return this.dirtyKeys.size > 0 && !this.provisionalOnly()
	}

	// Steps to undo and to redo.
	get depth(): { readonly undo: number; readonly redo: number } {
		return { undo: this.cursor, redo: this.entries.length - this.cursor }
	}

	// Steps held and their bytes (accounting, tests).
	get size(): { readonly steps: number; readonly bytes: number } {
		return { steps: this.entries.length, bytes: this.bytes }
	}

	// The id of the current state's step (0 before any), and whether it is the saved state.
	get current(): number {
		return this.entries[this.cursor - 1]?.id ?? 0
	}

	// Steps applied since the saved state, which this timeline still holds; undefined when it does not (its branch
	// was discarded or trimmed away) or lies ahead (undone past it).
	get sinceSaved(): number | undefined {
		return this.savedReachable && this.saved.pos <= this.cursor ? this.cursor - this.saved.pos : undefined
	}

	get atSaved(): boolean {
		return this.savedReachable && this.saved.pos === this.cursor && this.saved.baseline.size === 0
	}

	// The net bytes dirty against the saved state, estimated (0 when clean).
	get dirtyBytes(): number {
		return this.dirtyKeys.size === 0 || this.provisionalOnly() ? 0 : this.dirtyTotal
	}

	// The keys dirty against the saved state.
	dirtyTouchKeys(): ReadonlySet<TouchKey> {
		return this.dirtyKeys
	}

	// The fingerprint a dirty key had in the saved state.
	savedFingerprint(key: TouchKey): Fingerprint | undefined {
		return this.saved.baseline.get(key) ?? this.savedValue.get(key)
	}

	// A step applied now. `burst` steps of one burst coalesce into the step on top while it is not the saved state.
	// `continues`: the step goes on from the last push, still on top (the first text in notes it just made): one step,
	// undone together, redone as the last push's op then this one's.
	// `provisional`: the step makes nothing the user sees yet (notes started, nothing typed in them): while it is the last
	// push and on top it is not dirty on its own, and a save or an undo takes it back first.
	push(step: Omit<HistoryStep, "id">, options: { readonly continues?: boolean; readonly provisional?: boolean } = {}): HistoryStep {
		const record: PushRecord = {
			redo: [],
			trimmed: [],
			anchors: new Map(),
			saved: this.saved,
			savedReachable: this.savedReachable,
			provisional: options.provisional === true
		}

		const continued = options.continues === true ? this.lastPush?.step : undefined

		this.lastPush = undefined
		this.recording = record
		this.discardRedo()

		if (
			continued !== undefined &&
			continued === this.entries[this.cursor - 1] &&
			continued.lead === undefined &&
			this.saved.pos !== this.cursor &&
			!this.pendingAt(this.cursor)
		) {
			this.recording = undefined

			return this.coalesce(continued, step, continued.op)
		}

		const top = this.entries[this.cursor - 1]

		if (step.burst !== undefined && top?.burst === step.burst && this.saved.pos !== this.cursor && !this.pendingAt(this.cursor)) {
			// A coalesced step is not retracted: its burst's earlier state is gone.
			this.recording = undefined

			return this.coalesce(top, step)
		}

		const entry: HistoryStep = { ...step, id: nextId++, counted: undefined }

		this.entries.push(entry)
		this.cursor++
		this.bytes += entry.bytes
		this.revision++
		this.enter(entry)
		// The step's after-state is the model's now (its caller read it just before): no key it names is read again.
		this.refreshKeys(entry.before.keys(), entry.after)
		this.trim(entry.after)
		this.recording = undefined
		record.step = entry
		record.revision = this.revision
		this.lastPush = record

		return entry
	}

	// The step on top when it is the last push and nothing but saves came after it (its revision is `revision`):
	// retract() can take it back. Its inverse is applied by the caller first.
	retractable(revision: number): HistoryStep | undefined {
		const record = this.lastPush

		return record?.revision === revision && this.revision === revision && record.step === this.entries[this.cursor - 1]
			? record.step
			: undefined
	}

	// The provisional step on top (the last push, nothing done since), if there is one.
	provisionalTop(): HistoryStep | undefined {
		const record = this.lastPush

		return record?.provisional === true && record.step === this.entries[this.cursor - 1] ? record.step : undefined
	}

	// The revision the provisional step on top answered when it was pushed.
	provisionalRevision(): number | undefined {
		return this.provisionalTop() === undefined ? undefined : this.lastPush?.revision
	}

	// The provisional step on top is all that differs from the saved state: every dirty key is one it touched, and was
	// as saved before it. By fingerprint, so a state the saved one matches anywhere in the timeline (a retracted step
	// made again) counts; O(the step's keys).
	private provisionalOnly(): boolean {
		const step = this.provisionalTop()

		if (step === undefined) return false

		let others = this.dirtyKeys.size

		for (const [key, prior] of step.before) {
			if (!this.dirtyKeys.has(key)) continue

			const saved = this.saved.baseline.get(key) ?? this.savedValue.get(key)

			if (saved === undefined ? this.inRange.get(key) !== 1 : !sameFingerprint(saved, prior)) return false

			others--
		}

		return others === 0
	}

	// Takes the last push back as if it had never been applied: the redo branch it discarded and the oldest steps it
	// trimmed come back, the anchors it moved are as they were, and it leaves no redo step. A save that landed or
	// started on it meanwhile keeps the step's after-state in its baseline (that state is the file's, so the deck is
	// dirty against it).
	retract(): void {
		const record = this.lastPush
		const step = record?.step

		if (record === undefined || step === undefined || step !== this.entries[this.cursor - 1]) return

		this.lastPush = undefined

		const from = this.cursor - 1
		// Anchors made after the push (a save's) sit on the step.
		const later = [this.saved, ...this.pending.values()].filter(anchor => !record.anchors.has(anchor) && anchor.pos > from)

		for (const anchor of later) {
			for (const [key, value] of step.after) this.keepSaved(anchor, key, value)

			this.lose(anchor, step)
			anchor.pos = from
		}

		this.entries.pop()
		this.bytes -= step.bytes
		this.cursor--

		const trimmed = record.trimmed.length

		if (trimmed > 0) {
			this.entries.unshift(...record.trimmed)
			this.cursor += trimmed

			for (const entry of record.trimmed) this.bytes += entry.bytes
			for (const anchor of later) anchor.pos += trimmed
		}

		for (const entry of record.redo) {
			this.entries.push(entry)
			this.bytes += entry.bytes
		}

		for (const [anchor, copy] of record.anchors) {
			anchor.pos = copy.pos

			for (const key of copy.baselineAdded) anchor.baseline.delete(key)

			const keys = anchor.lost.keys as Set<TouchKey>

			for (const key of copy.lost.keysAdded) keys.delete(key)

			anchor.lost.bytes = copy.lost.bytes
			anchor.lost.dirty = copy.lost.dirty
		}

		this.savedReachable = this.saved === record.saved && !later.includes(this.saved) ? record.savedReachable : false
		this.revision++
		this.rebuild()
	}

	// The step to undo (its inverse is applied by the caller, then undone() records it).
	peekUndo(): HistoryStep | undefined {
		return this.entries[this.cursor - 1]
	}

	peekRedo(): HistoryStep | undefined {
		return this.entries[this.cursor]
	}

	// Every step held, undoable and redoable (what a save's pruning judges reachable).
	steps(): readonly HistoryStep[] {
		return this.entries
	}

	undone(): void {
		this.lastPush = undefined

		const entry = this.entries[this.cursor - 1]

		if (entry === undefined) return

		this.cursor--
		this.revision++

		if (this.saved.pos <= this.cursor) this.leave(entry)
		else this.enter(entry)

		this.refreshKeys(entry.before.keys())
	}

	redone(): void {
		this.lastPush = undefined

		const entry = this.entries[this.cursor]

		if (entry === undefined) return

		this.cursor++
		this.revision++

		if (this.saved.pos >= this.cursor) this.leave(entry)
		else this.enter(entry)

		this.refreshKeys(entry.before.keys())
	}

	// A redone step's inverse, made again as it applied (its bytes read from the base source as it is now).
	replaceInverse(step: HistoryStep, inverse: Inverse): void {
		this.lastPush = undefined

		const bytes = step.bytes - step.inverse.bytes + inverse.bytes

		this.bytes += bytes - step.bytes
		step.inverse = inverse
		step.bytes = bytes
		this.trim()
	}

	// A save of the current state starts: the point to commit when it lands.
	savePoint(): SavePoint {
		const point: SavePoint = { revision: this.revision }

		this.pending.set(point, { pos: this.cursor, baseline: new Map(), lost: noneLost() })

		return point
	}

	// A save landed: its state is the saved one.
	commit(point: SavePoint): void {
		const anchor = this.pending.get(point)

		if (anchor === undefined) return

		this.pending.delete(point)
		this.saved = anchor
		this.savedReachable = anchor.baseline.size === 0
		this.rebuild()
	}

	// A save that failed or was abandoned.
	abandon(point: SavePoint): void {
		this.pending.delete(point)
	}

	// Everything forgotten (a deck reopened from scratch): the current state is saved.
	clear(): void {
		this.lastPush = undefined
		this.entries.length = 0
		this.cursor = 0
		this.bytes = 0
		this.pending.clear()
		this.saved = { pos: 0, baseline: new Map(), lost: noneLost() }
		this.savedReachable = true
		this.rebuild()
	}

	// An anchor as it is now, kept once for the push in progress before it changes.
	private preserve(anchor: Anchor): void {
		const record = this.recording

		if (record === undefined || record.anchors.has(anchor)) return

		record.anchors.set(anchor, {
			pos: anchor.pos,
			baselineAdded: [],
			lost: { bytes: anchor.lost.bytes, keysAdded: [], dirty: anchor.lost.dirty }
		})
	}

	// A key's saved fingerprint kept in an anchor's baseline (the first one kept stays), noted for the push in progress.
	private keepSaved(anchor: Anchor, key: TouchKey, value: Fingerprint): void {
		if (anchor.baseline.has(key)) return

		anchor.baseline.set(key, value)
		this.recording?.anchors.get(anchor)?.baselineAdded.push(key)
	}

	private pendingAt(pos: number): boolean {
		for (const anchor of this.pending.values()) if (anchor.pos === pos) return true

		return false
	}

	// `lead`: the top step's op, run first on a redo (a continued step); else the top's own lead is kept.
	private coalesce(top: HistoryStep, step: Omit<HistoryStep, "id">, lead?: DeckOp): HistoryStep {
		const touches = [...top.touches]
		const before = new Map(top.before)
		const named = new Set(top.touches.map(touchKey))

		for (const touch of step.touches) {
			if (named.has(touchKey(touch))) continue

			named.add(touchKey(touch))
			touches.push(touch)
		}

		for (const [key, value] of step.before) if (!before.has(key)) before.set(key, value)

		const after = new Map(top.after)

		for (const [key, value] of step.after) after.set(key, value)

		const kept = lead ?? top.lead
		const merged: HistoryStep = {
			id: nextId++,
			op: step.op,
			inverse: top.inverse,
			touches,
			before,
			after,
			bytes: lead === undefined ? top.bytes - opBytesOf(top.op) + opBytesOf(step.op) : top.bytes + opBytesOf(step.op),
			// A continued step takes the burst of the text it continues with, so that burst's later typing joins it.
			burst: lead === undefined ? top.burst : step.burst,
			counted: undefined,
			...(kept === undefined ? {} : { lead: kept })
		}

		this.leave(top)
		this.entries[this.cursor - 1] = merged
		this.bytes += merged.bytes - top.bytes
		this.revision++
		this.enter(merged)
		this.refreshKeys(merged.before.keys())
		this.trim()

		return merged
	}

	// The redo branch, dropped when a new step is applied; anchors on it keep their fingerprints in their baselines.
	private discardRedo(): void {
		if (this.cursor === this.entries.length) return

		this.dropFrom(this.cursor)
	}

	private dropFrom(from: number): void {
		const anchors: Anchor[] = [this.saved, ...this.pending.values()]

		for (const anchor of anchors) {
			if (anchor.pos <= from) continue

			this.preserve(anchor)

			// The saved state was on the dropped steps: their after-state is what it held.
			for (let index = anchor.pos - 1; index >= from; index--) {
				const entry = this.entries[index] as HistoryStep

				for (const [key, value] of entry.after) this.keepSaved(anchor, key, value)

				this.lose(anchor, entry)
			}

			anchor.pos = from

			if (anchor === this.saved) this.savedReachable = false
		}

		for (let index = from; index < this.entries.length; index++) this.bytes -= (this.entries[index] as HistoryStep).bytes

		if (this.recording !== undefined) this.recording.redo = this.entries.slice(from)

		this.entries.length = from

		if (this.cursor > from) this.cursor = from

		this.rebuild()
	}

	// `now`: fingerprints of the model as it is, where known.
	private trim(now?: ReadonlyMap<TouchKey, Fingerprint>): void {
		while (this.entries.length > 0 && (this.entries.length > this.limits.maxSteps || this.bytes > this.limits.maxBytes)) {
			if (this.cursor === 0) {
				this.dropFrom(this.entries.length - 1)

				continue
			}

			const oldest = this.entries.shift() as HistoryStep

			this.bytes -= oldest.bytes
			this.cursor--
			this.recording?.trimmed.push(oldest)

			for (const anchor of [this.saved, ...this.pending.values()]) {
				this.preserve(anchor)

				if (anchor.pos > 0) {
					anchor.pos--

					continue
				}

				// The anchor is at the bottom: the step leaves its range, its before-state is what the anchor held.
				for (const [key, value] of oldest.before) this.keepSaved(anchor, key, value)

				this.lose(anchor, oldest)

				if (anchor === this.saved) {
					this.savedReachable = false
					this.leave(oldest)
					this.refreshKeys(oldest.before.keys(), now)
				}
			}
		}
	}

	// A step entering the saved anchor's range (at its end when the anchor is behind, at its front when ahead). The
	// saved value of a key is the before-state of the first step touching it when behind, the after-state of the last
	// one when ahead: a key new to the range takes it from this step; one already in range keeps its own.
	private enter(entry: HistoryStep): void {
		const behind = this.saved.pos <= this.cursor

		this.countStep(entry)

		for (const key of entry.before.keys()) {
			const count = this.inRange.get(key) ?? 0

			this.inRange.set(key, count + 1)

			if (count > 0) continue

			const value = behind ? entry.before.get(key) : entry.after.get(key)

			if (value !== undefined) this.savedValue.set(key, value)
		}
	}

	// A step leaving the range at the side away from the anchor's derivation: the keys it alone touched leave.
	private leave(entry: HistoryStep): void {
		const counted = entry.counted

		if (counted?.live === true) {
			counted.live = false
			this.uncount(counted)
		}

		for (const key of entry.before.keys()) {
			const count = (this.inRange.get(key) ?? 1) - 1

			if (count <= 0) {
				this.inRange.delete(key)
				this.savedValue.delete(key)
			} else {
				this.inRange.set(key, count)
			}
		}
	}

	// The saved anchor's derived state from a scan of its range (after it moved or steps left).
	private rebuild(): void {
		this.inRange.clear()
		this.savedValue.clear()
		for (const entry of this.entries) if (entry.counted !== undefined) entry.counted.live = false

		this.countedByKey.clear()
		this.dirtyKeys.clear()
		this.dirtyTotal = 0

		this.count(this.saved.lost)

		const { pos } = this.saved

		if (pos <= this.cursor) {
			for (let index = pos; index < this.cursor; index++) {
				const entry = this.entries[index] as HistoryStep

				this.countStep(entry)

				for (const key of entry.before.keys()) {
					this.inRange.set(key, (this.inRange.get(key) ?? 0) + 1)

					const value = entry.before.get(key)

					if (!this.savedValue.has(key) && value !== undefined) this.savedValue.set(key, value)
				}
			}
		} else {
			for (let index = pos - 1; index >= this.cursor; index--) {
				const entry = this.entries[index] as HistoryStep

				this.countStep(entry)

				for (const key of entry.before.keys()) {
					this.inRange.set(key, (this.inRange.get(key) ?? 0) + 1)

					const value = entry.after.get(key)

					if (!this.savedValue.has(key) && value !== undefined) this.savedValue.set(key, value)
				}
			}
		}

		const keys = new Set<TouchKey>([...this.inRange.keys(), ...this.saved.baseline.keys()])

		this.refreshKeys(keys)
	}

	// `now`: fingerprints of the model as it is, where known (the rest are read).
	private refreshKeys(keys: Iterable<TouchKey>, now?: ReadonlyMap<TouchKey, Fingerprint>): void {
		for (const key of keys) {
			const saved = this.saved.baseline.get(key) ?? this.savedValue.get(key)
			const dirty = saved === undefined ? this.inRange.has(key) : !sameFingerprint(saved, now?.get(key) ?? this.fingerprint(key))

			if (dirty === this.dirtyKeys.has(key)) continue

			if (dirty) this.dirtyKeys.add(key)
			else this.dirtyKeys.delete(key)

			for (const counted of this.countedByKey.get(key) ?? []) {
				if (dirty) {
					if (counted.dirty++ === 0) this.dirtyTotal += counted.bytes
				} else if (--counted.dirty === 0) {
					this.dirtyTotal -= counted.bytes
				}
			}
		}
	}

	// A step entering the saved anchor's range is counted (anew: a step re-entering is counted as it is now).
	private countStep(entry: HistoryStep): void {
		const counted = (entry.counted ??= stepCount(entry))

		if (counted.live) this.uncount(counted)

		counted.live = true
		this.count(counted)
	}

	// A step leaves the timeline into an anchor's baseline: its bytes and keys join the anchor's lost count.
	private lose(anchor: Anchor, entry: HistoryStep): void {
		const lost = anchor.lost
		const keys = lost.keys as Set<TouchKey>
		const counted = anchor === this.saved
		const bytes = (entry.counted ??= stepCount(entry)).bytes

		if (counted && lost.dirty > 0) this.dirtyTotal += bytes

		lost.bytes += bytes

		const added = this.recording?.anchors.get(anchor)?.lost.keysAdded

		for (const key of entry.before.keys()) {
			if (keys.has(key)) continue

			keys.add(key)
			added?.push(key)

			if (!counted) continue

			this.indexed(key).add(lost)

			if (this.dirtyKeys.has(key) && lost.dirty++ === 0) this.dirtyTotal += lost.bytes
		}
	}

	private indexed(key: TouchKey): Set<Counted> {
		let set = this.countedByKey.get(key)

		if (set === undefined) {
			set = new Set()
			this.countedByKey.set(key, set)
		}

		return set
	}

	private count(counted: Counted): void {
		counted.dirty = 0

		for (const key of counted.keys.keys()) {
			this.indexed(key).add(counted)

			if (this.dirtyKeys.has(key)) counted.dirty++
		}

		if (counted.dirty > 0) this.dirtyTotal += counted.bytes
	}

	private uncount(counted: Counted): void {
		if (counted.dirty > 0) this.dirtyTotal -= counted.bytes

		for (const key of counted.keys.keys()) {
			const set = this.countedByKey.get(key)

			set?.delete(counted)

			if (set?.size === 0) this.countedByKey.delete(key)
		}
	}
}

// The key of what a touch names (a shape's xfrm, one of its property groups, its text, its whole node; a slide's
// part or node; a presentation-level list; a package part).
export function touchKey(touch: Touch): TouchKey {
	switch (touch.kind) {
		case "shape":
			return `s:${String(touch.slide)}:${String(touch.shape)}:${dirtKey(touch.dirt)}`
		case "slide":
			return `n:${String(touch.slide)}:${dirtKey(touch.dirt)}`
		case "presentation":
			return `d:${touch.what}`
		case "part":
			return `p:${touch.change}:${touch.part}`
	}
}

function dirtKey(dirt: Dirt): string {
	switch (dirt.kind) {
		case "xfrm":
			return "x"
		case "props":
			return `p.${dirt.group}`
		case "text":
			return "t"
		case "slidePart":
			return `sp.${dirt.part}`
		case "node":
			return "n"
	}
}

// An estimate of the bytes an op holds (its typed values and raw bytes), for the history's accounting.
export function opBytesOf(op: DeckOp): number {
	return valueBytes(op, 0)
}

function valueBytes(value: unknown, depth: number): number {
	if (value === null || value === undefined) return 0
	if (typeof value === "string") return 16 + value.length * 2
	if (typeof value !== "object") return 8
	if (ArrayBuffer.isView(value)) return 32 + value.byteLength
	if (depth > 64) return 0

	let total = 16

	if (Array.isArray(value)) {
		for (const item of value) total += 8 + valueBytes(item, depth + 1)

		return total
	}

	for (const key in value) total += 16 + valueBytes((value as Record<string, unknown>)[key], depth + 1)

	return total
}
