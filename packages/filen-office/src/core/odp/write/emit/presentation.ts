import { checkOdpShow } from "../../../presentation/edit/apply/presentation"
import { refused, type Deck, type Refused, type ShowSettings, type SlideRef } from "../../../presentation/model"
import { escapeAttribute } from "../../../xml/index"
import type { OdpEmitFamily } from "../emit"

// The presentation family writes presentation:settings, never a page's element: its emit is never asked for one.
export const emitOdpPresentation: OdpEmitFamily = {
	emit: () => refused("unsupported", "odp emit presentation: no page element")
}

// One presentation:settings attribute (ODF 1.3 Part 3 §9.6), by its local name: the value to write when the written
// one does not already read as `show` says (the ODP reader's mapping), or undefined to remove it.
export interface SettingsAttribute {
	readonly local: string
	readonly value: string | undefined
	readonly holds: (written: string | undefined) => boolean
}

const PAUSE = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/u

function pauseMs(written: string | undefined): number | undefined {
	const match = written === undefined ? null : PAUSE.exec(written)

	return match === null
		? undefined
		: Math.round((Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0)) * 1000)
}

function flag(local: string, on: boolean, onValue: string, offValue: string): SettingsAttribute {
	return { local, value: on ? onValue : offValue, holds: written => (written === onValue) === on }
}

// The settings attributes saying `show` for the deck's pages as named after the save; refused when ODF cannot.
export function settingsAttributes(
	deck: Deck,
	show: ShowSettings,
	names: ReadonlyMap<SlideRef, string>
): readonly SettingsAttribute[] | Refused {
	const failure = checkOdpShow(deck, show)

	if (failure !== undefined) return failure

	const range = show.range
	let custom: string | undefined
	let start: string | undefined

	if (range.kind === "customShow") {
		custom = deck.customShows.find(each => each.id === range.id)?.name

		if (custom === undefined) return refused("notFound", `custom show ${String(range.id)}`)
	} else if (range.kind === "range") {
		const ref = deck.slides[range.start - 1]

		start = ref === undefined ? undefined : names.get(ref)

		if (start === undefined) return refused("notFound", `show start slide ${String(range.start)}`)
	}

	const pause = show.restartMs

	return [
		flag("endless", show.loop, "true", "false"),
		flag("force-manual", !show.useTimings, "true", "false"),
		flag("animations", !show.showAnimation, "disabled", "enabled"),
		flag("full-screen", show.kind === "browse", "false", "true"),
		{ local: "show", value: custom, holds: written => written === custom },
		{ local: "start-page", value: start, holds: written => written === start },
		{
			local: "pause",
			value: pause === undefined ? undefined : `PT${String(pause / 1000)}S`,
			// Read only while looping.
			holds: written => (!show.loop && pause === undefined) || pauseMs(written) === pause
		}
	]
}

// The attributes of a new presentation:settings (only what differs from an element without them).
export function newSettingsAttributes(attributes: readonly SettingsAttribute[], prefix: string): string {
	return attributes
		.filter(attribute => !attribute.holds(undefined) && attribute.value !== undefined)
		.map(attribute => ` ${prefix}:${attribute.local}="${escapeAttribute(attribute.value ?? "")}"`)
		.join("")
}

// The nearest settings ODF holds (a conversion into ODP): what it cannot hold is approximated or left out, by what.
export function odfShow(
	deck: Deck,
	show: ShowSettings
): { readonly show: ShowSettings; readonly approximated: readonly string[]; readonly omitted: readonly string[] } {
	const approximated: string[] = []
	const omitted: string[] = []
	const out: ShowSettings = { ...show }

	// A kiosk always loops on its timings (as the player runs it); its restart after inactivity is no pause between loops.
	if (out.kind === "kiosk") {
		approximated.push("kiosk mode")
		out.kind = "present"
		out.loop = true
		out.useTimings = true

		if (out.restartMs !== undefined) {
			omitted.push("kiosk restart")
			delete out.restartMs
		}
	}

	if (out.showNarration !== undefined) {
		// ODF has no narration: an explicit "without narration" is lost, "with" is what a reader assumes anyway.
		if (!out.showNarration) omitted.push("narration")
		delete out.showNarration
	}

	if (out.penColor !== undefined) {
		omitted.push("pen colour")
		delete out.penColor
	}

	if (out.restartMs !== undefined && !out.loop) {
		omitted.push("pause")
		delete out.restartMs
	}

	if (out.range.kind === "range" && out.range.end !== deck.slides.length) {
		approximated.push("slide range end")
		out.range = { kind: "range", start: out.range.start, end: deck.slides.length }
	}

	return { show: out, approximated, omitted }
}
