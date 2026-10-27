import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import type { Node } from "prosemirror-model"
import type { DeckOp, ShapeRef } from "@filen/office/core/presentation"
import {
	FIND_IN_NOTES,
	FIND_IN_SMARTART,
	FIND_IN_TABLE,
	FIND_LOCKED,
	PRESENTATION_FIND_INTS,
	PRESENTATION_FIND_LIMIT,
	type CommandResult,
	type OpenInfo,
	type PresentationSessionApi
} from "@filen/office/dom/presentation"
import type { ShapeSelection, TextEditing } from "@filen/office/react/presentation"
import type { DocxFindControls } from "@/features/preview/components/docxViewer.logic"

// Find and replace in the presentation editor, as the document viewers' find field drives it (DocxFindControls, so
// the shell mounts DocxFindField unchanged). The worker searches the deck (slides, notes, tables, SmartArt) and
// answers PRESENTATION_FIND_INTS per match: slide index, shape id, paragraph, start, end, flags. A step shows the
// match's slide, selects its shape and opens a slide shape's text with the match selected. Replace sends the open
// body's pending text, then one command: a text.replace (slide shapes, notes, table cells) and a smartart.replace per
// diagram, batched when there are both (one undo step); the shell reports its refusal. A match in a locked shape
// (FIND_LOCKED) is found but never replaced: Replace all leaves those shapes out and says how many matches it skipped,
// Replace on one says it cannot. Replace all over more matches than a find lists refuses (its targets would be partial).

export interface PresentationFindEditor {
	readonly text: TextEditing
	readonly selection: ShapeSelection
	// Shows the slide at this index of info.slides.
	show(index: number): void
	// Opens a slide shape's text in the editor (the shell mounts the text editor on it).
	openText(shape: ShapeRef): void
	// Runs an op through the session; the shell reports a refusal.
	command(op: DeckOp): Promise<CommandResult>
}

export interface PresentationFindInput {
	readonly session: PresentationSessionApi | undefined
	readonly info: OpenInfo | undefined
	readonly editor: PresentationFindEditor | undefined
	// After a replace, how many matches were replaced (the shell's notice).
	readonly onReplaced?: (count: number) => void
}

export interface FindMatch {
	readonly slide: number
	readonly shape: number
	readonly paragraph: number
	readonly start: number
	readonly end: number
	readonly flags: number
}

export function matchAt(matches: Int32Array, index: number): FindMatch | undefined {
	const at = index * PRESENTATION_FIND_INTS

	if (index < 0 || at + PRESENTATION_FIND_INTS > matches.length) return undefined

	return {
		slide: matches[at] ?? 0,
		shape: matches[at + 1] ?? 0,
		paragraph: matches[at + 2] ?? 0,
		start: matches[at + 3] ?? 0,
		end: matches[at + 4] ?? 0,
		flags: matches[at + 5] ?? 0
	}
}

// The editor position of `offset` in paragraph `paragraph`'s find text: text and a:br count the same in both, a field
// or content kept as source counts its text in find text and one position in the editor (an offset inside one lands
// after it).
export function findOffsetToPos(doc: Node, paragraph: number, offset: number): number | undefined {
	if (paragraph < 0 || paragraph >= doc.childCount) return undefined

	let pos = 1

	for (let p = 0; p < paragraph; p++) pos += doc.child(p).nodeSize

	const node = doc.child(paragraph)
	let left = offset
	let at = pos

	for (let index = 0; index < node.childCount && left > 0; index++) {
		const child = node.child(index)
		const findLength = child.isText
			? (child.text?.length ?? 0)
			: child.type.name === "br"
				? 1
				: String(child.attrs["text"] ?? "").length

		if (child.isText && left < findLength) return at + left

		left -= findLength
		at += child.nodeSize
	}

	return Math.min(at, pos + node.content.size)
}

export function replaceable(match: FindMatch): boolean {
	return (match.flags & FIND_LOCKED) === 0
}

// Replace-all targets: one per shape (notes bodies apart); slide shapes, notes and tables in a text.replace, each
// SmartArt diagram in a smartart.replace of its own. Matches in locked shapes are no target: `skipped` counts them,
// `replaced` the others.
export function replaceTargets(
	matches: Int32Array,
	count: number,
	info: OpenInfo
): {
	readonly text: { target: ShapeRef; notes?: true }[]
	readonly smartart: ShapeRef[]
	readonly replaced: number
	readonly skipped: number
} {
	const seen = new Set<string>()
	const text: { target: ShapeRef; notes?: true }[] = []
	const smartart: ShapeRef[] = []
	let replaced = 0
	let skipped = 0

	for (let index = 0; index < count; index++) {
		const match = matchAt(matches, index)
		const slide = match === undefined ? undefined : info.slides[match.slide]?.ref

		if (match === undefined || slide === undefined) continue

		if (!replaceable(match)) {
			skipped++

			continue
		}

		replaced++

		const notes = (match.flags & FIND_IN_NOTES) !== 0
		const key = `${String(match.slide)}:${String(match.shape)}:${notes ? "n" : "s"}`

		if (seen.has(key)) continue

		seen.add(key)

		const target = { slide, id: match.shape }

		if ((match.flags & FIND_IN_SMARTART) !== 0) smartart.push(target)
		else text.push(notes ? { target, notes: true } : { target })
	}

	return { text, smartart, replaced, skipped }
}

function someReplaceable(matches: Int32Array, count: number): boolean {
	for (let index = 0; index < count; index++) if (((matches[index * PRESENTATION_FIND_INTS + 5] ?? 0) & FIND_LOCKED) === 0) return true

	return false
}

interface FindState {
	readonly query: string
	readonly caseSensitive: boolean
	readonly matches: Int32Array
	readonly count: number
	readonly capped: boolean
	readonly active: number
}

const EMPTY: FindState = { query: "", caseSensitive: false, matches: new Int32Array(0), count: 0, capped: false, active: -1 }

export function usePresentationFind({ session, info, editor, onReplaced }: PresentationFindInput): DocxFindControls {
	const { t } = useTranslation("preview")
	const [state, setState] = useState<FindState>(EMPTY)
	const sequence = useRef(0)
	// A body to select once the shell has opened it.
	const pendingSelect = useRef<{ readonly shape: ShapeRef; readonly match: FindMatch } | undefined>(undefined)

	useEffect(() => {
		const text = editor?.text

		if (text === undefined) return

		const select = (): void => {
			const pending = pendingSelect.current
			const active = text.active

			if (pending === undefined || active === undefined) return
			if (active.shape.slide !== pending.shape.slide || active.shape.id !== pending.shape.id) return

			pendingSelect.current = undefined

			const doc = active.state.doc
			const from = findOffsetToPos(doc, pending.match.paragraph, pending.match.start)
			const to = findOffsetToPos(doc, pending.match.paragraph, pending.match.end)

			if (from !== undefined && to !== undefined) active.setSelection(from, to)
		}

		return text.subscribe(select)
	}, [editor?.text])

	const run = async (query: string, caseSensitive: boolean, active: number): Promise<void> => {
		const ticket = ++sequence.current

		if (session === undefined || query === "") {
			setState({ ...EMPTY, query, caseSensitive })

			return
		}

		const matches = await session.find(query, { caseSensitive, limit: PRESENTATION_FIND_LIMIT })

		if (ticket !== sequence.current) return

		const total = matches.length / PRESENTATION_FIND_INTS
		const count = Math.min(total, PRESENTATION_FIND_LIMIT)

		setState({
			query,
			caseSensitive,
			matches,
			count,
			capped: total > PRESENTATION_FIND_LIMIT,
			active: count === 0 ? -1 : Math.min(active, count - 1)
		})
	}

	const go = (index: number): void => {
		const match = matchAt(state.matches, index)
		const slide = match === undefined ? undefined : info?.slides[match.slide]?.ref

		if (match === undefined || slide === undefined || editor === undefined) return

		editor.show(match.slide)

		if ((match.flags & FIND_IN_NOTES) !== 0) return

		editor.selection.show(slide)
		editor.selection.set([match.shape])

		if ((match.flags & (FIND_IN_TABLE | FIND_IN_SMARTART)) !== 0) return

		const shape = { slide, id: match.shape }

		pendingSelect.current = { shape, match }

		const active = editor.text.active

		if (active?.shape.slide === slide && active.shape.id === match.shape) {
			const from = findOffsetToPos(active.state.doc, match.paragraph, match.start)
			const to = findOffsetToPos(active.state.doc, match.paragraph, match.end)

			pendingSelect.current = undefined

			if (from !== undefined && to !== undefined) active.setSelection(from, to)
		} else {
			editor.openText(shape)
		}
	}

	const replace = async (replacement: string, all: boolean): Promise<void> => {
		if (editor === undefined || info === undefined || state.count === 0) return

		await editor.text.flush()

		const query = { query: state.query, replacement, caseSensitive: state.caseSensitive } as const
		let replaced = 0

		if (all) {
			// The listed matches are not all of them: replacing only theirs would leave the rest unannounced.
			if (state.capped) {
				toast.error(t("previewPptxFindReplaceCapped", { count: PRESENTATION_FIND_LIMIT }))

				return
			}

			const { text, smartart, replaced: replaceableCount, skipped } = replaceTargets(state.matches, state.count, info)
			// Text bodies, tables and every diagram in one command: one undo step.
			const ops: DeckOp[] = [
				...(text.length > 0 ? [{ family: "text", kind: "replace", ...query, targets: text } as const] : []),
				...smartart.map(target => ({ family: "smartart", kind: "replace", target, ...query }) as const)
			]
			const op: DeckOp | undefined = ops.length === 1 ? ops[0] : ops.length > 1 ? { family: "batch", kind: "batch", ops } : undefined

			if (op !== undefined && (await editor.command(op)).ok) replaced = replaceableCount
			if (skipped > 0) toast.warning(t("previewPptxFindSkippedLocked", { count: skipped }))
		} else {
			const match = matchAt(state.matches, Math.max(0, state.active))
			const slide = match === undefined ? undefined : info.slides[match.slide]?.ref

			if (match === undefined || slide === undefined) return

			if (!replaceable(match)) {
				toast.error(t("previewPptxFindLocked"))

				return
			}

			const target = { slide, id: match.shape }
			const at = [match.paragraph, match.start, match.end] as const
			const notes = (match.flags & FIND_IN_NOTES) !== 0
			const result = await editor.command(
				(match.flags & FIND_IN_SMARTART) !== 0
					? { family: "smartart", kind: "replace", target, ...query, match: at }
					: { family: "text", kind: "replace", ...query, targets: [{ target, ...(notes ? { notes: true } : {}), match: at }] }
			)

			if (result.ok) replaced = 1
		}

		if (replaced > 0) onReplaced?.(replaced)

		await run(state.query, state.caseSensitive, state.active)
	}

	return {
		query: state.query,
		caseSensitive: state.caseSensitive,
		count: state.count,
		capped: state.capped,
		active: state.active,
		search: (query, caseSensitive) => {
			void run(query, caseSensitive, 0)
		},
		step: direction => {
			if (state.count === 0) return

			const next = (state.active + direction + state.count) % state.count

			setState(previous => ({ ...previous, active: next }))
			go(next)
		},
		close: () => {
			sequence.current++
			pendingSelect.current = undefined
			setState(EMPTY)
		},
		...(info?.editable === true && editor !== undefined
			? {
					replace: {
						// Nothing found can be replaced: every match is in a locked shape.
						disabled: state.count > 0 && !someReplaceable(state.matches, state.count),
						one: (replacement: string) => {
							void replace(replacement, false)
						},
						all: (replacement: string) => {
							void replace(replacement, true)
						}
					}
				}
			: {})
	}
}
