import type { NudgeDirection } from "../../../core/presentation/edit/commands/shape"
import type { ZOrder } from "../../../core/presentation/edit/ops"

// The canvas's keys while shapes are selected. The editing keys PowerPoint fixes (arrows nudge, Shift+arrows nudge
// further, Delete/Backspace, Tab/Shift+Tab to the next/previous shape, Enter into the text, Escape) are fixed here;
// the commands a user may rebind (select all, group, ungroup, z-order) come as combos from the app's keymap, in
// react-hotkeys-hook's syntax ("mod+shift+g"), so the canvas and the shortcuts list agree.

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
	| { readonly kind: "delete" }
	| { readonly kind: "cycle"; readonly back: boolean }
	| { readonly kind: "enter" }
	| { readonly kind: "escape" }
	| { readonly kind: "command"; readonly command: ObjectCommand }

export interface KeyLike {
	readonly key: string
	readonly code: string
	readonly shiftKey: boolean
	readonly ctrlKey: boolean
	readonly metaKey: boolean
	readonly altKey: boolean
}

interface Combo {
	readonly mod: boolean
	readonly ctrl: boolean
	readonly meta: boolean
	readonly shift: boolean
	readonly alt: boolean
	// KeyboardEvent.code of the key (layout-independent, so Shift+] is still BracketRight).
	readonly code: string
}

const NAMED_CODES: Readonly<Record<string, string>> = {
	"[": "BracketLeft",
	"]": "BracketRight",
	"-": "Minus",
	"=": "Equal",
	",": "Comma",
	".": "Period",
	"/": "Slash",
	";": "Semicolon",
	"'": "Quote",
	"`": "Backquote",
	"\\": "Backslash",
	space: "Space",
	enter: "Enter",
	tab: "Tab",
	escape: "Escape",
	esc: "Escape",
	delete: "Delete",
	backspace: "Backspace",
	up: "ArrowUp",
	down: "ArrowDown",
	left: "ArrowLeft",
	right: "ArrowRight"
}

function codeOf(key: string): string {
	const named = NAMED_CODES[key]

	if (named !== undefined) return named
	if (/^[a-z]$/u.test(key)) return `Key${key.toUpperCase()}`
	if (/^[0-9]$/u.test(key)) return `Digit${key}`
	if (/^f([1-9]|1[0-9]|2[0-4])$/u.test(key)) return key.toUpperCase()

	return key
}

// One combo of react-hotkeys-hook's syntax (modifiers and one key joined by "+"); undefined for a sequence or an
// empty one.
export function parseCombo(combo: string): Combo | undefined {
	const parts = combo
		.toLowerCase()
		.split("+")
		.map(part => part.trim())
	const key = parts.pop()

	if (key === undefined || key === "" || combo.includes(">")) return undefined

	const has = (name: string): boolean => parts.includes(name)

	return {
		mod: has("mod"),
		ctrl: has("ctrl") || has("control"),
		meta: has("meta") || has("cmd") || has("command"),
		shift: has("shift"),
		alt: has("alt") || has("option"),
		code: codeOf(key)
	}
}

// Whether `event` is `combo`; `apple`: Mod is Cmd (else Ctrl).
export function matchesCombo(event: KeyLike, combo: Combo, apple: boolean): boolean {
	const ctrl = combo.ctrl || (combo.mod && !apple)
	const meta = combo.meta || (combo.mod && apple)

	return (
		event.code === combo.code &&
		event.ctrlKey === ctrl &&
		event.metaKey === meta &&
		event.shiftKey === combo.shift &&
		event.altKey === combo.alt
	)
}

const ARROWS: Readonly<Record<string, NudgeDirection>> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" }

// Parsed once per bindings object.
const parsed = new WeakMap<ObjectKeyBindings, readonly (readonly [ObjectCommand, Combo])[]>()

function combosOf(bindings: ObjectKeyBindings): readonly (readonly [ObjectCommand, Combo])[] {
	const known = parsed.get(bindings)

	if (known !== undefined) return known

	const out: (readonly [ObjectCommand, Combo])[] = []

	for (const command of OBJECT_COMMANDS) {
		const combo = parseCombo(bindings[command])

		if (combo !== undefined) out.push([command, combo])
	}

	parsed.set(bindings, out)

	return out
}

// What a key press on the canvas does; undefined: not the canvas's (it goes on to the editor and the app).
export function objectKeyAction(event: KeyLike, bindings: ObjectKeyBindings, apple: boolean): ObjectKeyAction | undefined {
	for (const [command, combo] of combosOf(bindings)) if (matchesCombo(event, combo, apple)) return { kind: "command", command }

	const modified = event.ctrlKey || event.metaKey || event.altKey
	const direction = ARROWS[event.code] ?? ARROWS[event.key]

	if (direction !== undefined && !modified) return { kind: "nudge", direction, large: event.shiftKey }
	if (modified) return undefined

	switch (event.key) {
		case "Delete":
		case "Backspace":
			return event.shiftKey ? undefined : { kind: "delete" }
		case "Tab":
			return { kind: "cycle", back: event.shiftKey }
		case "Enter":
		case "F2":
			return event.shiftKey ? undefined : { kind: "enter" }
		case "Escape":
			return { kind: "escape" }
		default:
			return undefined
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
