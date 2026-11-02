import { useSyncExternalStore } from "react"
import { EditorState } from "prosemirror-state"
import { selectAllIn, type TextCommand } from "../../../../core/presentation/edit/commands/text"
import type { DeckOp } from "../../../../core/presentation/edit/ops"
import type { CommandResult, PresentationSessionApi } from "../../../../dom/presentation/protocol"
import { PresentationError, type ShapeRef } from "../../../../core/presentation/model"
import { bodyToDoc, docToBody, presentationTextSchema } from "../../../../core/presentation/text/schema"
import { defaultsOf, type TextEditController } from "./controller"
import { DEFAULT_TEXT_BINDINGS, textKeyCommand, type TextKeyBindings, type TextKeyCommand } from "./keys"

// The text editing of one open deck, for the ribbon and the find field: the controller of the body being edited (if
// any). One store per deck; the editor view registers its controller while it is mounted.

export interface TextEditing {
	readonly active: TextEditController | undefined
	set(controller: TextEditController | undefined): void
	subscribe(listener: () => void): () => void
	// The open body's pending setText, sent (the shell awaits it before any other command).
	flush(): Promise<void>
	// Whether the open body holds changes the worker has not answered yet (typed, sent, or held behind a step); the
	// listeners hear when it flips. False with no body open.
	readonly pending: boolean
	// A command through the session: with a body open, after its pending setText and naming it, so an answer that
	// changed it reseeds the view (find's replace); else the session's own.
	command(op: DeckOp, session: PresentationSessionApi): Promise<CommandResult>
	// The link key pressed in the open body: the host that shows the link dialog hears it. Whether one did.
	requestLink(): boolean
	onLinkRequest(listener: () => void): () => void
	// A revision counter of the active controller's state (for React).
	readonly version: number
	// Keys typed while a body is being opened (asked for, its editor not ready yet: a seed, notes still being made) are
	// held, in order, from expect() until the editor takes them (take()) or the opening is given up (drop()). Only while
	// focus stays where the open was asked (the element focused at the first expect(), or an element of the body being
	// opened, marked data-fo-text-opening): focus anywhere else drops them, and the editor then leaves focus there.
	// Escape in that time gives the opening up (`onCancel`, the opener's).
	// `anchor`: the element the open was asked from (the notes area), the place keys are held for when focus is on the
	// page around it (a click that focuses no button, as Safari's): focus on that page itself still holds, focus moved
	// into any other control drops. A shortcut goes to the page and the holding goes on; only focus that really moves
	// ends it and keeps the editor from taking focus. `keys`: the body's key bindings, so its formatting keys (Mod+B…) are held too and applied in order.
	expect(options?: {
		readonly onCancel?: () => void
		readonly anchor?: Element | null
		readonly keys?: { readonly bindings?: TextKeyBindings; readonly apple?: boolean }
	}): void
	take(): TypedAhead[] & { readonly focusMoved: boolean }
	drop(): void
}

// A key held for a body that is opening: text (its characters, coalesced), a paragraph or line break, a Backspace, one
// of the body's bound commands (Mod+B…).
export type TypedAhead =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "enter"; readonly line: boolean }
	| { readonly kind: "backspace" }
	| { readonly kind: "command"; readonly command: TextKeyCommand }

// Whether the platform's command key is Meta (Apple's).
export function applePlatform(): boolean {
	return /Mac|iPhone|iPad/u.test(String(Reflect.get(Reflect.get(globalThis, "navigator") ?? {}, "platform") ?? ""))
}

// Whether a key goes to a field of its own (an input, a text area, an editable element), not to the body opening.
function inField(target: EventTarget | null): boolean {
	const element = target as { readonly tagName?: string; readonly isContentEditable?: boolean } | null

	return element?.tagName === "INPUT" || element?.tagName === "TEXTAREA" || element?.isContentEditable === true
}

// The held form of a key, or undefined for one that is not text input (shortcuts, navigation, an input method's).
// AltGr (Windows, some layouts) arrives as Ctrl+Alt with the character it types.
function altGraph(event: KeyboardEvent): boolean {
	return event.ctrlKey && event.altKey && !event.metaKey && [...event.key].length === 1
}

// A shortcut (Mod+F, Mod+Z…): the user turned to something else, not to typing into the body.
function isShortcut(event: KeyboardEvent): boolean {
	return (event.ctrlKey || event.metaKey) && !altGraph(event) && !["Control", "Meta", "Shift", "Alt", "AltGraph"].includes(event.key)
}

function heldKey(event: KeyboardEvent): TypedAhead | undefined {
	if (event.isComposing || event.keyCode === 229 || ((event.ctrlKey || event.metaKey) && !altGraph(event))) return undefined
	if (event.key === "Enter") return { kind: "enter", line: event.shiftKey }
	if (event.key === "Backspace" && !event.altKey) return { kind: "backspace" }

	return [...event.key].length === 1 ? { kind: "text", text: event.key } : undefined
}

export function createTextEditing(): TextEditing {
	const listeners = new Set<() => void>()
	const linkListeners = new Set<() => void>()
	let active: TextEditController | undefined
	let detach: (() => void) | undefined
	let version = 0
	let held: TypedAhead[] | undefined
	// Where the open was asked from, a cancel, and whether focus went elsewhere since the last expect().
	let origin: Element | null = null
	// The element focused at expect() when it was the page around the anchor (only it, never what it contains).
	let start: Element | null = null
	let cancel: (() => void) | undefined
	let focusMoved = false
	// The opening body's bindings: its formatting keys are held with the text.
	let keys: { readonly bindings: TextKeyBindings; readonly apple: boolean } | undefined
	const doc = (): Document | undefined => (globalThis as { document?: Document }).document
	const allowed = (element: Element | null): boolean =>
		element !== null &&
		(element === origin ||
			element === start ||
			origin?.contains(element) === true ||
			element.closest("[data-fo-text-opening]") !== null)
	// Captured at the document before anything else hears it (the button that opened the body would open it again).
	const hold = (event: KeyboardEvent): void => {
		if (held === undefined || inField(event.target) || !allowed(doc()?.activeElement ?? null)) return

		if (event.key === "Escape" && !event.isComposing && cancel !== undefined) {
			const giveUp = cancel

			event.preventDefault()
			event.stopImmediatePropagation()
			release()
			giveUp()

			return
		}

		if (isShortcut(event)) {
			const command = keys === undefined ? undefined : textKeyCommand(event, keys.bindings, keys.apple)

			// Any other shortcut goes on to the page (Mod+S saves, Mod+Z undoes). The holding goes on: what is typed after
			// it is still the body's, unless the shortcut moves focus (Mod+F to the find field: the focusin listener sees
			// that and drops what was held, and the editor leaves focus there).
			if (command === undefined || command === "link") return

			event.preventDefault()
			event.stopImmediatePropagation()
			held.push({ kind: "command", command })

			return
		}

		const key = heldKey(event)

		if (key === undefined) return

		event.preventDefault()
		event.stopImmediatePropagation()

		const last = held[held.length - 1]

		if (key.kind === "text" && last?.kind === "text") held[held.length - 1] = { kind: "text", text: last.text + key.text }
		else held.push(key)
	}
	// Focus that goes anywhere else (the find field, a ribbon tab, a dialog, a menu) drops what was held: those keys
	// were the user's for that control, and nothing more is held.
	const moved = (event: FocusEvent): void => {
		if (held === undefined || allowed(event.target as Element | null)) return

		focusMoved = true
		release()
	}
	const bump = (): void => {
		version++

		for (const listener of listeners) listener()
	}
	const release = (): TypedAhead[] => {
		const out = held ?? []

		if (held !== undefined) {
			doc()?.removeEventListener("keydown", hold, true)
			doc()?.removeEventListener("focusin", moved, true)
		}

		held = undefined
		cancel = undefined
		keys = undefined

		return out
	}

	return {
		get active() {
			return active
		},
		get version() {
			return version
		},
		set(controller) {
			if (controller === active) return

			detach?.()
			detach = undefined
			active = controller
			detach = controller?.subscribe(bump)
			bump()
		},
		subscribe(listener) {
			listeners.add(listener)

			return () => {
				listeners.delete(listener)
			}
		},
		flush: () => active?.flush() ?? Promise.resolve(),
		get pending() {
			return active?.pending ?? false
		},
		command: (op, session) => (active === undefined ? session.command(op) : active.command(op)),
		expect(options) {
			// Focus went elsewhere while this body opened: it holds nothing more until it is taken or given up.
			if (held === undefined && focusMoved) return
			if (options?.onCancel !== undefined) cancel = options.onCancel
			if (options?.keys !== undefined)
				keys = { bindings: options.keys.bindings ?? DEFAULT_TEXT_BINDINGS, apple: options.keys.apple ?? applePlatform() }
			if (held !== undefined) return

			held = []
			const focused = doc()?.activeElement ?? null
			const anchor = options?.anchor ?? null

			// Focus on the page around the anchor (or nowhere): the anchor is where keys are held for.
			if (anchor !== null && (focused === null || focused === anchor || focused.contains(anchor))) {
				origin = anchor
				start = focused
			} else {
				origin = focused
				start = null
			}

			focusMoved = false
			doc()?.addEventListener("keydown", hold, true)
			doc()?.addEventListener("focusin", moved, true)
		},
		take() {
			const wasMoved = focusMoved

			focusMoved = false

			return Object.assign(release(), { focusMoved: wasMoved })
		},
		drop() {
			focusMoved = false
			release()
		},
		requestLink() {
			for (const listener of linkListeners) listener()

			return linkListeners.size > 0
		},
		onLinkRequest(listener) {
			linkListeners.add(listener)

			return () => {
				linkListeners.delete(listener)
			}
		}
	}
}

// Re-renders on every change of the active body (selection, format, layout).
export function useTextEditing(editing: TextEditing): TextEditController | undefined {
	useSyncExternalStore(
		editing.subscribe,
		() => editing.version,
		() => editing.version
	)

	return editing.active
}

// A text command on whole shapes that are selected but not being edited (the ribbon with shapes selected): each body
// is seeded, formatted with everything selected and set, one command per shape. The result per shape: the command's,
// or undefined when the command changed nothing there. `send` runs each setText (the shell's command path, which
// reports refusals; the session's own by default).
export async function formatShapes(
	session: PresentationSessionApi,
	shapes: readonly ShapeRef[],
	command: (defaults: ReturnType<typeof defaultsOf>) => TextCommand,
	send: (op: DeckOp) => Promise<CommandResult> = op => session.command(op)
): Promise<(CommandResult | undefined)[]> {
	const results: (CommandResult | undefined)[] = []

	for (const shape of shapes) {
		let result: CommandResult | undefined

		try {
			const seed = await session.textSeed(shape)
			const { doc, origins } = bodyToDoc(seed.body)
			const state = selectAllIn(EditorState.create({ doc, schema: presentationTextSchema }))
			let next = state

			command(defaultsOf(seed))(state, tr => {
				next = state.apply(tr)
			})

			result =
				next.doc === state.doc
					? undefined
					: await send({ family: "text", kind: "setText", target: shape, body: docToBody(next.doc, seed.body, origins) })
		} catch (error) {
			result = { ok: false, refusal: error instanceof PresentationError ? error.reason : "failed" }
		}

		results.push(result)
	}

	return results
}
