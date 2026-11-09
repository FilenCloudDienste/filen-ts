import type { ShowController } from "../show/controller"
import type { InkStore } from "../ink/store"

// The slideshow's keys, PowerPoint's: they drive the show's controller and the ink, from the audience stage and the
// presenter view alike, and from presentation clickers (which send PageDown, PageUp, B, F5 and Escape). The commands
// a user may rebind come as combos in the app keymap's syntax, alternatives comma-separated ("arrowright,n"), so the
// show and the shortcuts list agree. A slide number typed and then Enter goes to that slide; Escape puts a pen down
// before it ends the show. Period and comma are named ("period", "comma", the recorder's tokens): a literal comma
// separates alternatives.

export type ShowKeyCommand =
	| "next"
	| "previous"
	| "first"
	| "last"
	| "nextHidden"
	| "black"
	| "white"
	| "end"
	| "laser"
	| "pen"
	| "eraser"
	| "arrow"
	| "eraseAll"
	| "start"
	| "startCurrent"

export type ShowKeyBindings = Readonly<Record<ShowKeyCommand, string>>

export const DEFAULT_SHOW_BINDINGS: ShowKeyBindings = {
	next: "arrowright,arrowdown,pagedown,space,enter,n",
	previous: "arrowleft,arrowup,pageup,backspace,p",
	first: "home",
	last: "end",
	// The slide after the current one when it is hidden (the run skips hidden slides).
	nextHidden: "h",
	black: "b,period",
	white: "w,comma",
	end: "escape",
	laser: "mod+l",
	pen: "mod+p",
	eraser: "mod+e",
	arrow: "mod+a",
	eraseAll: "e",
	// In the editor: from the first slide, from the current one. In the show a clicker's F5 does nothing (and never
	// reloads the page).
	start: "f5",
	startCurrent: "shift+f5"
}

export interface ShowKeyEvent {
	readonly key: string
	readonly code: string
	readonly shiftKey: boolean
	readonly ctrlKey: boolean
	readonly metaKey: boolean
	readonly altKey: boolean
	readonly repeat?: boolean
	preventDefault(): void
	stopPropagation(): void
}

interface Chord {
	readonly mod: boolean
	readonly ctrl: boolean
	readonly meta: boolean
	readonly shift: boolean
	readonly alt: boolean
	readonly codes: readonly string[]
}

const NAMED: Readonly<Record<string, readonly string[]>> = {
	arrowright: ["ArrowRight"],
	right: ["ArrowRight"],
	arrowleft: ["ArrowLeft"],
	left: ["ArrowLeft"],
	arrowup: ["ArrowUp"],
	up: ["ArrowUp"],
	arrowdown: ["ArrowDown"],
	down: ["ArrowDown"],
	pageup: ["PageUp"],
	pagedown: ["PageDown"],
	home: ["Home"],
	end: ["End"],
	space: ["Space"],
	enter: ["Enter", "NumpadEnter"],
	return: ["Enter", "NumpadEnter"],
	escape: ["Escape"],
	esc: ["Escape"],
	backspace: ["Backspace"],
	delete: ["Delete"],
	tab: ["Tab"],
	".": ["Period"],
	period: ["Period"],
	comma: ["Comma"],
	"/": ["Slash"],
	"-": ["Minus"],
	"=": ["Equal"]
}

function codesOf(key: string): readonly string[] {
	const named = NAMED[key]

	if (named !== undefined) return named
	if (/^[a-z]$/u.test(key)) return [`Key${key.toUpperCase()}`]
	if (/^[0-9]$/u.test(key)) return [`Digit${key}`, `Numpad${key}`]
	if (/^f([1-9]|1[0-9]|2[0-4])$/u.test(key)) return [key.toUpperCase()]

	// Any other key as the recorder spells it: its code lowercased ("semicolon", "bracketleft").
	return [key]
}

// The chords of a combo (alternatives comma-separated, modifiers and one key joined by "+"); a sequence or an
// empty alternative is no chord.
export function parseShowCombo(combo: string): Chord[] {
	const out: Chord[] = []

	for (const alternative of combo.toLowerCase().split(",")) {
		if (alternative.includes(">")) continue

		const parts = alternative.split("+").map(part => part.trim())
		const key = parts.pop()

		if (key === undefined || key === "") continue

		const has = (name: string): boolean => parts.includes(name)

		out.push({
			mod: has("mod"),
			ctrl: has("ctrl") || has("control"),
			meta: has("meta") || has("cmd") || has("command"),
			shift: has("shift"),
			alt: has("alt") || has("option"),
			codes: codesOf(key)
		})
	}

	return out
}

// `code`: the event's code lowercased, for keys bound by their recorded token.
function matches(event: ShowKeyEvent, code: string, chord: Chord, apple: boolean): boolean {
	return (
		(chord.codes.includes(event.code) || chord.codes.includes(code)) &&
		event.ctrlKey === (chord.ctrl || (chord.mod && !apple)) &&
		event.metaKey === (chord.meta || (chord.mod && apple)) &&
		event.shiftKey === chord.shift &&
		event.altKey === chord.alt
	)
}

const parsed = new WeakMap<ShowKeyBindings, readonly (readonly [ShowKeyCommand, Chord])[]>()

function chordsOf(bindings: ShowKeyBindings): readonly (readonly [ShowKeyCommand, Chord])[] {
	let out = parsed.get(bindings)

	if (out === undefined) {
		const list: (readonly [ShowKeyCommand, Chord])[] = []

		for (const command of Object.keys(bindings) as ShowKeyCommand[])
			for (const chord of parseShowCombo(bindings[command])) list.push([command, chord])

		out = list
		parsed.set(bindings, out)
	}

	return out
}

// The rebindable command `event` is, if any; `apple`: Mod is Cmd (else Ctrl).
export function showKeyCommand(event: ShowKeyEvent, bindings: ShowKeyBindings, apple: boolean): ShowKeyCommand | undefined {
	const code = event.code.toLowerCase()

	for (const [command, chord] of chordsOf(bindings)) if (matches(event, code, chord, apple)) return command

	return undefined
}

// Shift+F10 or the Menu key (PowerPoint's "Open a context menu"), on Windows and the Mac alike. Not rebindable.
export function isContextMenuKey(event: {
	readonly key: string
	readonly shiftKey: boolean
	readonly ctrlKey: boolean
	readonly metaKey: boolean
	readonly altKey: boolean
}): boolean {
	if (event.ctrlKey || event.metaKey || event.altKey) return false

	return event.key === "ContextMenu" ? !event.shiftKey : event.key === "F10" && event.shiftKey
}

export interface ShowKeysOptions {
	readonly controller: () => ShowController | undefined
	readonly ink?: InkStore
	// The slide on stage, for erasing its ink.
	readonly slide?: () => Parameters<InkStore["clear"]>[0] | undefined
	// Slides in the deck (End without a controller that knows its last slide).
	readonly count?: () => number
	readonly bindings?: ShowKeyBindings
	readonly apple: boolean
}

export interface ShowKeys {
	// Handles a keydown in the show; true when it was the show's (default prevented, propagation stopped).
	onKeyDown(event: ShowKeyEvent): boolean
	// The slide number typed so far ("" when none).
	readonly typed: string
}

const DIGIT = /^(?:Digit|Numpad)([0-9])$/u

// The controller's first() or last() (the running sequence's ends), where the player has them; whether it did.
function callOptional(controller: ShowController | undefined, name: "first" | "last"): boolean {
	const method: unknown = controller === undefined ? undefined : Reflect.get(controller, name)

	if (typeof method !== "function") return false

	Reflect.apply(method, controller, [])

	return true
}

export function createShowKeys(options: ShowKeysOptions): ShowKeys {
	let typed = ""

	const run = (command: ShowKeyCommand): void => {
		const controller = options.controller()
		const ink = options.ink

		switch (command) {
			case "next":
				controller?.next()
				return
			case "previous":
				controller?.prev()
				return
			case "first":
				if (!callOptional(controller, "first")) controller?.goto(0)
				return
			case "last":
				if (!callOptional(controller, "last")) controller?.goto(Math.max(0, (options.count?.() ?? 1) - 1))
				return
			case "nextHidden":
				controller?.nextHidden?.()
				return
			case "black":
				controller?.black()
				return
			case "white":
				controller?.white()
				return
			case "end":
				if (ink !== undefined && ink.getSnapshot().tool !== "none") ink.setTool("none")
				else controller?.end()
				return
			case "laser":
				ink?.setTool(ink.getSnapshot().tool === "laser" ? "none" : "laser")
				return
			case "pen":
				ink?.setTool(ink.getSnapshot().tool === "pen" ? "none" : "pen")
				return
			case "eraser":
				ink?.setTool(ink.getSnapshot().tool === "eraser" ? "none" : "eraser")
				return
			case "arrow":
				ink?.setTool("none")
				return
			case "eraseAll": {
				const slide = options.slide?.()

				if (slide !== undefined) ink?.clear(slide)

				return
			}
			case "start":
			case "startCurrent":
		}
	}

	return {
		get typed() {
			return typed
		},
		onKeyDown: event => {
			const modified = event.ctrlKey || event.metaKey || event.altKey
			const digit = modified ? undefined : DIGIT.exec(event.code)?.[1]

			if (digit !== undefined) {
				typed = (typed + digit).slice(-6)
				event.preventDefault()
				event.stopPropagation()

				return true
			}

			if (typed !== "" && !modified && (event.code === "Enter" || event.code === "NumpadEnter")) {
				const number = Number(typed)

				typed = ""
				event.preventDefault()
				event.stopPropagation()

				if (number >= 1) options.controller()?.goto(number - 1)

				return true
			}

			typed = ""

			const command = showKeyCommand(event, options.bindings ?? DEFAULT_SHOW_BINDINGS, options.apple)

			if (command === undefined) return false

			event.preventDefault()
			event.stopPropagation()

			// Holding a toggle or Escape does not flip it back and forth; held arrows step on.
			if (event.repeat === true && (command === "black" || command === "white" || command === "end" || command === "eraseAll"))
				return true

			run(command)

			return true
		}
	}
}
