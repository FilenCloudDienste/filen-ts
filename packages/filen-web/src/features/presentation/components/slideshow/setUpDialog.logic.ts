import type { ShowSettings } from "@filen/office/core/presentation"
import type { ShowOptions } from "@filen/office/react/presentation"

// Set Up Slide Show's form and the show options it gives.

// PowerPoint restarts a kiosk show after five minutes without input.
export const KIOSK_RESTART_MS = 5 * 60 * 1000

export interface SetUpForm {
	readonly kiosk: boolean
	readonly loop: boolean
	readonly slides: "all" | "range" | "custom"
	// Slide numbers as typed.
	readonly from: string
	readonly to: string
	readonly custom: number | undefined
	readonly timings: boolean
}

export function setUpForm(options: ShowOptions, slideCount: number): SetUpForm {
	return {
		kiosk: options.kiosk,
		loop: options.loop,
		slides: options.customShow !== undefined ? "custom" : options.range !== undefined ? "range" : "all",
		from: String(options.range?.start ?? 1),
		// A file's range may end past the last slide: offered up to it.
		to: String(Math.min(options.range?.end ?? slideCount, Math.max(1, slideCount))),
		custom: options.customShow,
		timings: options.useTimings
	}
}

function slideNumber(text: string): number | undefined {
	const trimmed = text.trim()

	return /^\d+$/u.test(trimmed) ? Number(trimmed) : undefined
}

export function setUpRangeValid(form: SetUpForm, slideCount: number): boolean {
	const from = slideNumber(form.from)
	const to = slideNumber(form.to)

	return from !== undefined && to !== undefined && from >= 1 && to <= slideCount && from <= to
}

// `opened`: the options the dialog opened with, whose settings it does not show (show without animation, pen colour)
// are kept.
export function setUpOptions(form: SetUpForm, opened?: ShowOptions): ShowOptions {
	const from = slideNumber(form.from)
	const to = slideNumber(form.to)

	return {
		...(opened?.withoutAnimation === true ? { withoutAnimation: true } : {}),
		...(opened?.penColor === undefined ? {} : { penColor: opened.penColor }),
		kiosk: form.kiosk,
		loop: form.loop || form.kiosk,
		useTimings: form.timings || form.kiosk,
		...(form.slides === "range" && from !== undefined && to !== undefined ? { range: { start: from, end: to } } : {}),
		...(form.slides === "custom" && form.custom !== undefined ? { customShow: form.custom } : {}),
		...(form.kiosk ? { restartMs: KIOSK_RESTART_MS } : {})
	}
}

// The deck's show settings (saved in the file) after Set Up Slide Show: what the form sets, and what it does not show
// (browsed by an individual, narration, animation, pen colour, a kiosk's own restart time) kept from `previous`.
export function showSettingsOf(options: ShowOptions, previous: ShowSettings | undefined): ShowSettings {
	const kind = options.kiosk ? "kiosk" : previous?.kind === "kiosk" || previous === undefined ? "present" : previous.kind
	const restartMs = options.kiosk ? ((previous?.kind === "kiosk" ? previous.restartMs : undefined) ?? options.restartMs) : undefined

	return {
		kind,
		loop: options.loop,
		showNarration: previous?.showNarration ?? true,
		showAnimation: previous?.showAnimation ?? true,
		useTimings: options.useTimings,
		range:
			options.customShow !== undefined
				? { kind: "customShow", id: options.customShow }
				: options.range !== undefined
					? { kind: "range", start: options.range.start, end: options.range.end }
					: { kind: "all" },
		...(previous?.penColor === undefined ? {} : { penColor: previous.penColor }),
		...(restartMs === undefined ? {} : { restartMs })
	}
}
