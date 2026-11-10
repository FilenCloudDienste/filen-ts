import { matchesChord, parseCombo, type Chord, type ChordEvent } from "@filen/shared/keymap"
import type { ShowController } from "../show/controller"
import type { InkStore } from "../ink/store"
import type { PointerChange } from "../show/pointer"

// The slideshow's keys, PowerPoint's: they drive the show's controller and the ink, from the audience stage and the
// presenter view alike, and from presentation clickers (which send PageDown, PageUp, B, F5 and Escape). The commands
// a user may rebind come as combos in the app keymap's syntax, alternatives comma-separated ("arrowright,n", keys
// matched by physical key: @filen/shared/keymap), so the show and the shortcuts list agree. A slide number typed and
// then Enter goes to that slide; Escape puts a pen down before it ends the show.

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
	| "hidePointer"
	| "togglePointer"
	| "eraseAll"
	| "start"
	| "startCurrent"
	| "highlighter"
	| "presenterView"

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
	// Also returns the pointer to automatic (hidden once still).
	arrow: "mod+a",
	// Ctrl even on a Mac, where the system takes Cmd+H.
	hidePointer: "ctrl+h",
	togglePointer: "a,equal",
	eraseAll: "e",
	// In the editor: from the first slide, from the current one. In the show a clicker's F5 does nothing (and never
	// reloads the page).
	start: "f5",
	startCurrent: "shift+f5",
	highlighter: "mod+i",
	// In the editor: the presenter view, from the current slide.
	presenterView: "alt+f5"
}

export interface ShowKeyEvent {
	readonly key: string
	readonly code: string
	readonly shiftKey: boolean
	readonly ctrlKey: boolean
	readonly metaKey: boolean
	readonly altKey: boolean
	readonly repeat?: boolean
	getModifierState?(key: string): boolean
	preventDefault(): void
	stopPropagation(): void
}

// Parsed once per bindings object.
const parsed = new WeakMap<ShowKeyBindings, readonly (readonly [ShowKeyCommand, Chord])[]>()

function chordsOf(bindings: ShowKeyBindings): readonly (readonly [ShowKeyCommand, Chord])[] {
	let out = parsed.get(bindings)

	if (out === undefined) {
		const list: (readonly [ShowKeyCommand, Chord])[] = []

		for (const command of Object.keys(bindings) as ShowKeyCommand[])
			for (const chord of parseCombo(bindings[command])) list.push([command, chord])

		out = list
		parsed.set(bindings, out)
	}

	return out
}

// The rebindable command `event` is, if any; `apple`: Mod is Cmd (else Ctrl).
export function showKeyCommand(event: ChordEvent, bindings: ShowKeyBindings, apple: boolean): ShowKeyCommand | undefined {
	for (const [command, chord] of chordsOf(bindings)) if (matchesChord(event, chord, apple)) return command

	return undefined
}

// Enter or Space pressed on a control of the show's own (an ink tool, a presenter view button, a field) below where the
// keys are handled: the control's click, never the show's next slide.
export function pressesControl(event: {
	readonly key: string
	readonly target: EventTarget
	readonly currentTarget: EventTarget
}): boolean {
	if ((event.key !== "Enter" && event.key !== " ") || event.target === event.currentTarget) return false

	// Read structurally: these keys also build without the DOM's types.
	const element = event.target as { readonly closest?: (selectors: string) => unknown }

	return typeof element.closest === "function" && element.closest("button, a[href], input, select, textarea, [role='button']") !== null
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
	// The keys in effect (DEFAULT_SHOW_BINDINGS for a host without a keymap of its own): only these run a command, so a
	// key moved off one no longer does.
	readonly bindings: ShowKeyBindings
	readonly apple: boolean
	// The audience stage's pointer (show/pointer.ts changePointer).
	readonly pointer?: (change: PointerChange) => void
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
			case "highlighter":
				ink?.setTool(ink.getSnapshot().tool === "highlighter" ? "none" : "highlighter")
				return
			case "arrow":
				ink?.setTool("none")
				options.pointer?.("automatic")
				return
			case "hidePointer":
				options.pointer?.("hide")
				return
			case "togglePointer":
				options.pointer?.("toggle")
				return
			case "eraseAll": {
				const slide = options.slide?.()

				if (slide !== undefined) ink?.clear(slide)

				return
			}
			case "start":
			case "startCurrent":
			case "presenterView":
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

			const command = showKeyCommand(event, options.bindings, options.apple)

			if (command === undefined) return false

			event.preventDefault()
			event.stopPropagation()

			// Holding a toggle or Escape does not flip it back and forth; held arrows step on.
			if (
				event.repeat === true &&
				(command === "black" || command === "white" || command === "end" || command === "eraseAll" || command === "togglePointer")
			)
				return true

			run(command)

			return true
		}
	}
}
