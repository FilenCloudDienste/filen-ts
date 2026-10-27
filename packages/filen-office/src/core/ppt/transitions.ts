import { u32 } from "./records"
import type { SlideShowInfo } from "./slides"
import { xmlText } from "./text"

// A slide's transition ([MS-PPT] §2.6.6 SlideShowSlideInfoAtom) as PresentationML p:transition (ECMA-376 Part 1
// §19.3.1.50, §19.5): the effect and its variant, its speed, how the slide advances and the sound it starts or stops.
// Effects are named as PowerPoint names them in both formats (Cover Left is p:cover dir="l"; Uncover is p:pull; Box
// In/Out is p:zoom; Fade Through Black is p:fade thruBlk, Fade Smoothly p:fade). An effect type the format does not
// define is left out and reported.

export interface PptSound {
	readonly rId: string
	readonly name: string
}

export interface PptTransition {
	// The p:transition element, or "" when the slide has nothing to say (no effect, manual advance, no sound).
	readonly xml: string
	// The effect type was not one MS-PPT defines: the slide changes without it.
	readonly unsupported: boolean
}

// §2.6.6 flags.
const MANUAL = 0x1
const SOUND = 0x10
const LOOP = 0x40
const STOP_SOUND = 0x100
const AUTO = 0x400

const EIGHT = ["l", "u", "r", "d", "lu", "ru", "ld", "rd"]
const SIDES = ["l", "u", "r", "d"]
const SPOKES = new Set([1, 2, 3, 4, 8])
// §2.6.6 speed: 0.75 s, 0.5 s, 0.25 s (ECMA ST_TransitionSpeed slow, med, fast; fast is the default).
const SPEEDS = ["slow", "med", "fast"]
// The longest slide time §2.6.6 allows.
const MAX_SLIDE_TIME = 86_399_000

function element(type: number, direction: number): string | undefined {
	switch (type) {
		case 0:
			return direction === 1 ? '<p:cut thruBlk="1"/>' : ""
		case 1:
			return "<p:random/>"
		case 2:
			return `<p:blinds dir="${direction === 1 ? "horz" : "vert"}"/>`
		case 3:
			return `<p:checker dir="${direction === 1 ? "vert" : "horz"}"/>`
		case 4:
			return `<p:cover dir="${EIGHT[direction] ?? "l"}"/>`
		case 5:
			return "<p:dissolve/>"
		case 6:
			return '<p:fade thruBlk="1"/>'
		case 7:
			return `<p:pull dir="${EIGHT[direction] ?? "l"}"/>`
		case 8:
			return `<p:randomBar dir="${direction === 1 ? "vert" : "horz"}"/>`
		case 9:
			return `<p:strips dir="${EIGHT[direction >= 4 && direction <= 7 ? direction : 4] ?? "lu"}"/>`
		case 10:
			return `<p:wipe dir="${SIDES[direction] ?? "l"}"/>`
		case 11:
			return `<p:zoom dir="${direction === 1 ? "in" : "out"}"/>`
		case 13:
			return `<p:split orient="${direction >= 2 ? "vert" : "horz"}" dir="${direction % 2 === 1 ? "in" : "out"}"/>`
		case 17:
			return "<p:diamond/>"
		case 18:
			return "<p:plus/>"
		case 19:
			return "<p:wedge/>"
		case 20:
			return `<p:push dir="${SIDES[direction] ?? "l"}"/>`
		case 21:
			return `<p:comb dir="${direction === 1 ? "vert" : "horz"}"/>`
		case 22:
			return "<p:newsflash/>"
		case 23:
			return "<p:fade/>"
		case 26:
			return `<p:wheel spokes="${String(SPOKES.has(direction) ? direction : 4)}"/>`
		case 27:
			return "<p:circle/>"
		case 255:
			return ""
		default:
			return undefined
	}
}

export function transitionXml(show: SlideShowInfo, sound: (soundIdRef: number) => PptSound | undefined): PptTransition {
	const effect = element(show.effectType, show.effectDirection)
	const unsupported = effect === undefined
	const flags = show.flags
	const speed = SPEEDS[show.speed] ?? "fast"
	const attributes =
		`${speed === "fast" ? "" : ` spd="${speed}"`}${(flags & MANUAL) === 0 ? ' advClick="0"' : ""}` +
		((flags & AUTO) !== 0 ? ` advTm="${String(Math.max(0, Math.min(MAX_SLIDE_TIME, show.slideTime | 0)))}"` : "")
	let soundXml = ""

	if ((flags & STOP_SOUND) !== 0) {
		soundXml = "<p:sndAc><p:endSnd/></p:sndAc>"
	} else if ((flags & SOUND) !== 0 && show.raw.length >= 8) {
		const held = sound(u32(show.raw, 4))

		if (held !== undefined)
			soundXml = `<p:sndAc><p:stSnd${(flags & LOOP) !== 0 ? ' loop="1"' : ""}><p:snd r:embed="${held.rId}" name="${xmlText(held.name)}"/></p:stSnd></p:sndAc>`
	}

	const content = (effect ?? "") + soundXml

	// A slide without an effect, advanced by click at the default speed, says nothing.
	if (content === "" && attributes === "") return { xml: "", unsupported }

	return { xml: `<p:transition${attributes}>${content}</p:transition>`, unsupported }
}
