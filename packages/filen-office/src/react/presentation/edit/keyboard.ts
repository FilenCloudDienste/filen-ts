import { matchesChord, parseCombo, type Chord, type ChordEvent } from "@filen/shared/keymap"
import type { NudgeDirection } from "../../../core/presentation/edit/commands/shape"
import type { ZOrder } from "../../../core/presentation/edit/ops"

// The canvas's keys while shapes are selected. The editing keys PowerPoint fixes are fixed here: arrows nudge (on a
// Mac Cmd+arrows too, and Shift+arrows resize; elsewhere Shift+arrows nudge further), Alt+Left/Right turn 15°, Mod+D
// duplicates the objects (the slide's Mod+D is the slide list's), Delete/Backspace, Tab/Shift+Tab to the
// next/previous shape, Enter into the text, Escape. The commands a user may rebind (select all, group, ungroup,
// z-order) come as combos from the app's keymap (@filen/shared/keymap: "mod+shift+g", alternatives comma-separated,
// keys matched by physical key), so the canvas and the shortcuts list agree.

export type ObjectCommand = "selectAll" | "group" | "ungroup" | "bringToFront" | "sendToBack" | "bringForward" | "sendBackward"

export const OBJECT_COMMANDS: readonly ObjectCommand[] = [
	"selectAll",
	"group",
	"ungroup",
	"bringToFront",
	"sendToBack",
	"bringForward",
	"sendBackward"
]

export const Z_ORDER_OF: Readonly<Partial<Record<ObjectCommand, ZOrder>>> = {
	bringToFront: "front",
	sendToBack: "back",
	bringForward: "forward",
	sendBackward: "backward"
}

export type ObjectKeyBindings = Readonly<Record<ObjectCommand, string>>

export type ObjectKeyAction =
	| { readonly kind: "nudge"; readonly direction: NudgeDirection; readonly large: boolean }
	| { readonly kind: "resize"; readonly direction: NudgeDirection }
	| { readonly kind: "rotate"; readonly clockwise: boolean }
	| { readonly kind: "duplicate" }
	| { readonly kind: "delete" }
	| { readonly kind: "cycle"; readonly back: boolean }
	| { readonly kind: "enter"; readonly selectAll: boolean }
	| { readonly kind: "escape" }
	| { readonly kind: "command"; readonly command: ObjectCommand }
	// A character typed on the selection: it goes into the shape's text (PowerPoint's "select the shape, then type").
	| { readonly kind: "type"; readonly text: string }

export interface KeyLike extends ChordEvent {
	// An input method's key (its composition's): never typed as is.
	readonly isComposing?: boolean
}

const DUPLICATE: Chord = { mod: true, meta: false, ctrl: false, alt: false, shift: false, key: "d" }

const ARROWS: Readonly<Record<string, NudgeDirection>> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" }

// Parsed once per bindings object, every alternative of a combo.
const parsed = new WeakMap<ObjectKeyBindings, readonly (readonly [ObjectCommand, Chord])[]>()

function combosOf(bindings: ObjectKeyBindings): readonly (readonly [ObjectCommand, Chord])[] {
	const known = parsed.get(bindings)

	if (known !== undefined) return known

	const out: (readonly [ObjectCommand, Chord])[] = []

	for (const command of OBJECT_COMMANDS) for (const chord of parseCombo(bindings[command])) out.push([command, chord])

	parsed.set(bindings, out)

	return out
}

// An arrow with exactly these modifiers: none (nudge), Alt with Left/Right (turn 15°), and per platform Shift (resize
// on a Mac, a larger nudge elsewhere) and, on a Mac, Cmd (nudge).
function arrowAction(event: KeyLike, direction: NudgeDirection, apple: boolean): ObjectKeyAction | undefined {
	const { shiftKey: shift, ctrlKey: ctrl, metaKey: meta, altKey: alt } = event

	if (alt)
		return shift || ctrl || meta || direction === "up" || direction === "down"
			? undefined
			: { kind: "rotate", clockwise: direction === "right" }
	if (ctrl) return undefined
	if (meta) return apple && !shift ? { kind: "nudge", direction, large: false } : undefined
	if (shift && apple) return { kind: "resize", direction }

	return { kind: "nudge", direction, large: shift }
}

// What a key press on the canvas does; undefined: not the canvas's (it goes on to the editor and the app).
export function objectKeyAction(event: KeyLike, bindings: ObjectKeyBindings, apple: boolean): ObjectKeyAction | undefined {
	for (const [command, chord] of combosOf(bindings)) if (matchesChord(event, chord, apple)) return { kind: "command", command }

	if (matchesChord(event, DUPLICATE, apple)) return { kind: "duplicate" }

	const modified = event.ctrlKey || event.metaKey || event.altKey
	const direction = ARROWS[event.code] ?? ARROWS[event.key]

	if (direction !== undefined) return arrowAction(event, direction, apple)
	if (modified) return undefined

	switch (event.key) {
		case "Delete":
		case "Backspace":
			return event.shiftKey ? undefined : { kind: "delete" }
		case "Tab":
			return { kind: "cycle", back: event.shiftKey }
		// Enter selects the shape's text (PowerPoint); F2 puts the caret at its start.
		case "Enter":
		case "F2":
			return event.shiftKey ? undefined : { kind: "enter", selectAll: event.key === "Enter" }
		case "Escape":
			return { kind: "escape" }
		default:
			return [...event.key].length === 1 && event.isComposing !== true ? { kind: "type", text: event.key } : undefined
	}
}

// Tab's next shape: after the last selected one in z-order (back to front, wrapping); Shift+Tab before the first.
export function cycleTarget(order: readonly number[], selected: readonly number[], back: boolean): number | undefined {
	if (order.length === 0) return undefined

	const chosen = new Set(selected)
	let at = -1

	order.forEach((id, index) => {
		if (chosen.has(id) && (at < 0 || (back ? index < at : index > at))) at = index
	})

	if (at < 0) return back ? order[order.length - 1] : order[0]

	return order[(at + (back ? -1 : 1) + order.length) % order.length]
}
