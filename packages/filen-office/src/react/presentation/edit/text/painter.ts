import { useSyncExternalStore } from "react"
import type { EditorState } from "prosemirror-state"
import {
	caretRunProps,
	effectiveRunProps,
	mapRunProps,
	type TextCommand,
	type TextDefaults
} from "../../../../core/presentation/edit/commands/text"
import type { DeckOp } from "../../../../core/presentation/edit/ops"
import type { RunProps, ShapeRef } from "../../../../core/presentation/model"
import type { TextSeed } from "../../../../core/presentation/output"
import { runPropsOf } from "../../../../core/presentation/text/schema"
import type { CommandResult, PresentationSessionApi } from "../../../../dom/presentation/protocol"
import type { TextEditController } from "./controller"
import { formatShapesOp, type TextEditing } from "./editing"

// PowerPoint's Format Painter (Home ▸ Clipboard) for text: a click copies the character formatting of the open body's
// selection (its first character) or of the selected shapes' text (the first run), and the next click on the slide
// paints it: on a word or a dragged range of an open body, on a placeholder or text box the click opens (the word
// clicked), or on the whole text of the shapes it selects, one undo step. A double click keeps it on until clicked
// again or Esc. Hyperlinks and proofing (language, noProof) are the target's own and stay.

export type FormatPainterMode = "off" | "once" | "sticky"

// Run properties the target keeps: what a run links to and how it is proofed is not its look.
const KEPT = ["hlinkClick", "hlinkMouseOver", "lang", "altLang", "noProof"] as const

// What a property shows when no level sets it: a carried format without it turns the target's shown value back to this.
const NEUTRAL: { readonly [K in keyof RunProps]?: RunProps[K] } = {
	b: false,
	i: false,
	u: "none",
	strike: "noStrike",
	baseline: 0,
	cap: "none",
	spc: 0
}

// The formatting a painter carries from a run as shown (its rPr over the chain).
export function carriedRunProps(shown: RunProps): RunProps {
	const out: Record<string, unknown> = { ...shown }

	for (const key of KEPT) delete out[key]

	return out as RunProps
}

// A target run painted: the carried format, its own links and proofing, and neutral values where the carried format
// says nothing but the target's chain shows something.
export function paintedRunProps(carried: RunProps, local: RunProps, shown: RunProps): RunProps {
	const out: Record<string, unknown> = { ...carried }
	const had = shown as Record<string, unknown>

	for (const [key, value] of Object.entries(NEUTRAL)) {
		if (!(key in carried) && had[key] !== undefined && had[key] !== value) out[key] = value
	}

	for (const key of KEPT) if (local[key] !== undefined) out[key] = local[key]

	return out as RunProps
}

// Paints the selection (the word around a caret; else what is typed next).
export function paintRuns(carried: RunProps, defaults: TextDefaults): TextCommand {
	return mapRunProps(defaults, (local, shown) => paintedRunProps(carried, local, shown))
}

// The format a body's selection gives the painter: its first character's, else the caret's.
export function copiedRunProps(state: EditorState, defaults: TextDefaults): RunProps {
	const selection = state.selection
	let shown: RunProps | undefined

	if (!selection.empty) {
		state.doc.nodesBetween(selection.from, selection.to, (node, _pos, parent) => {
			if (shown !== undefined) return false
			if (!node.isText || parent === null) return true

			shown = effectiveRunProps(runPropsOf(node.marks, parent.attrs["endRPr"] as RunProps | null), parent, defaults)

			return false
		})
	}

	return carriedRunProps(shown ?? effectiveRunProps(caretRunProps(state), selection.$from.parent, defaults))
}

// The format a shape's text gives the painter: its first run as resolved, else its first paragraph's run defaults.
export function seedRunProps(seed: TextSeed): RunProps {
	for (const paragraph of seed.resolved) {
		const first = paragraph.runs[0]

		if (first !== undefined) return carriedRunProps(first)
	}

	return carriedRunProps(seed.resolved[0]?.pPr.defRPr ?? {})
}

// What the painter reads from and writes to: the deck's session, text store and command path, and the shapes selected.
export interface FormatPainterHost {
	readonly session: Pick<PresentationSessionApi, "textSeed">
	readonly text: TextEditing
	// The selected shapes that hold text; `entersText`: a click on the one selected opens its body (a placeholder or a
	// text box), which then takes the paint at the caret.
	targets(): { readonly shapes: readonly ShapeRef[]; readonly entersText: boolean }
	command(op: DeckOp): Promise<CommandResult>
}

export interface FormatPainter {
	readonly mode: FormatPainterMode
	subscribe(listener: () => void): () => void
	// Picks up the formatting of what `host` has selected; false when there is none (the painter stays off).
	copy(host: FormatPainterHost, sticky?: boolean): Promise<boolean>
	// The host as it is now (a newer render of the slide), while the painter is on.
	rebind(host: FormatPainterHost): void
	cancel(): void
}

// Where a click paints: the canvas overlay and the open body.
const CANVAS = "[data-fo-shape-edit], [data-fo-text-editor]"
const BODY = "[data-fo-text-editor]"

export function createFormatPainter(text: TextEditing): FormatPainter {
	const listeners = new Set<() => void>()
	let mode: FormatPainterMode = "off"
	let carried: RunProps = {}
	let host: FormatPainterHost | undefined
	// The press on the canvas the next release paints after: whether it was in the open body, and that body.
	let down: { readonly inBody: boolean; readonly controller: TextEditController | undefined } | undefined
	// A click opened a body: it takes the paint once ready (any controller other than `opening.from`).
	let opening: { readonly from: TextEditController | undefined } | undefined
	let detach: (() => void) | undefined

	const notify = (): void => {
		for (const listener of listeners) listener()
	}

	const off = (): void => {
		if (mode === "off") return

		mode = "off"
		carried = {}
		host = undefined
		down = undefined
		opening = undefined
		detach?.()
		detach = undefined
		notify()
	}

	const painted = (): void => {
		if (mode === "once") off()
	}

	const paintBody = (controller: TextEditController): void => {
		controller.run(paintRuns(carried, controller.defaults))
		painted()
	}

	const paintShapes = async (target: FormatPainterHost, shapes: readonly ShapeRef[]): Promise<void> => {
		const format = carried

		painted()

		const op = await formatShapesOp(target.session, shapes, defaults => paintRuns(format, defaults))

		if (op !== undefined) await target.command(op)
	}

	const settle = (press: NonNullable<typeof down>): void => {
		const active = text.active

		if (mode === "off" || host === undefined) return

		if (press.inBody && active !== undefined && active === press.controller) {
			paintBody(active)

			return
		}

		const { shapes, entersText } = host.targets()

		if (entersText) {
			// Opened already (rare: the seed is a worker round trip).
			if (active !== undefined && active !== press.controller) paintBody(active)
			else opening = { from: press.controller }

			return
		}

		if (shapes.length > 0) {
			void paintShapes(host, shapes)

			return
		}

		// A click on the empty slide puts a single-use painter down.
		painted()
	}

	const attach = (): void => {
		const doc = (globalThis as { document?: Document }).document

		if (doc === undefined || detach !== undefined) return

		const onDown = (event: PointerEvent): void => {
			const element = event.target instanceof Element ? event.target : null

			opening = undefined
			down =
				element === null || element.closest(CANVAS) === null
					? undefined
					: { inBody: element.closest(BODY) !== null, controller: text.active }
		}
		const onUp = (): void => {
			const press = down

			down = undefined

			// After the canvas has handled the release (selection, caret).
			if (press !== undefined) setTimeout(() => settle(press), 0)
		}
		const onKey = (event: KeyboardEvent): void => {
			if (event.key !== "Escape" || event.isComposing) return

			event.preventDefault()
			event.stopPropagation()
			off()
		}
		const unsubscribe = text.subscribe(() => {
			const active = text.active

			if (opening !== undefined && active !== undefined && active !== opening.from) {
				opening = undefined
				paintBody(active)
			}
		})

		doc.addEventListener("pointerdown", onDown, true)
		doc.addEventListener("pointerup", onUp)
		doc.addEventListener("keydown", onKey, true)
		detach = () => {
			doc.removeEventListener("pointerdown", onDown, true)
			doc.removeEventListener("pointerup", onUp)
			doc.removeEventListener("keydown", onKey, true)
			unsubscribe()
		}
	}

	return {
		get mode() {
			return mode
		},
		subscribe: listener => {
			listeners.add(listener)

			return () => {
				listeners.delete(listener)
			}
		},
		copy: async (target, sticky = false) => {
			const controller = target.text.active
			let format: RunProps | undefined

			if (controller !== undefined) {
				format = copiedRunProps(controller.state, controller.defaults)
			} else {
				const first = target.targets().shapes[0]
				const seed = first === undefined ? undefined : await target.session.textSeed(first).catch(() => undefined)

				format = seed === undefined ? undefined : seedRunProps(seed)
			}

			if (format === undefined) return false

			carried = format
			host = target
			down = undefined
			opening = undefined
			mode = sticky ? "sticky" : "once"
			attach()
			notify()

			return true
		},
		rebind: target => {
			if (mode !== "off") host = target
		},
		cancel: off
	}
}

const painters = new WeakMap<TextEditing, FormatPainter>()

// The deck's painter (one per text store, so one per open deck).
export function formatPainterOf(text: TextEditing): FormatPainter {
	let painter = painters.get(text)

	if (painter === undefined) {
		painter = createFormatPainter(text)
		painters.set(text, painter)
	}

	return painter
}

export function useFormatPainter(painter: FormatPainter): FormatPainterMode {
	return useSyncExternalStore(
		painter.subscribe,
		() => painter.mode,
		() => painter.mode
	)
}
