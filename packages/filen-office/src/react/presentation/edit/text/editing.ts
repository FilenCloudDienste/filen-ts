import { useSyncExternalStore } from "react"
import { EditorState } from "prosemirror-state"
import { selectAllIn, type TextCommand } from "../../../../core/presentation/edit/commands/text"
import type { DeckOp } from "../../../../core/presentation/edit/ops"
import type { CommandResult, PresentationSessionApi } from "../../../../dom/presentation/protocol"
import { PresentationError, type ShapeRef } from "../../../../core/presentation/model"
import { bodyToDoc, docToBody, presentationTextSchema } from "../../../../core/presentation/text/schema"
import { defaultsOf, type TextEditController } from "./controller"

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
}

export function createTextEditing(): TextEditing {
	const listeners = new Set<() => void>()
	const linkListeners = new Set<() => void>()
	let active: TextEditController | undefined
	let detach: (() => void) | undefined
	let version = 0

	const bump = (): void => {
		version++

		for (const listener of listeners) listener()
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
