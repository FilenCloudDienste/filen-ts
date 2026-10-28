import type { Transition } from "../../anim/model"
import { kindFromOdf } from "../../anim/presets/transitions/catalog"

// A drawing page's slide transition (ODF 1.3 Part 3 §17.25 style:drawing-page-properties: smil:type, smil:subtype,
// smil:direction, smil:fadeColor, presentation:transition-speed, presentation:transition-type and presentation:duration;
// §19.391 anim:transitionFilter in the page's timing root, which wins where both are written, as LibreOffice reads
// them) as the model's transition: the SMIL type and subtype mapped to the ECMA-376 transition they draw
// (§19.7.x p:transition children), or to the p14/p15 kind LibreOffice writes them for (miscShapeWipe…), with the SMIL
// names kept in `options` so nothing is lost; with the transition par's sound (anim:audio, or anim:command
// "stop-audio", as LibreOffice writes it).

const SPEEDS: Readonly<Record<string, number>> = { slow: 1000, medium: 750, fast: 500 }

function seconds(value: string | undefined): number | undefined {
	if (value === undefined) return undefined

	const match = /^\s*(?:PT)?(\d+(?:\.\d*)?)S?\s*$/iu.exec(value) ?? /^\s*(\d+(?:\.\d*)?)s\s*$/u.exec(value)

	if (match !== null) return Number(match[1]) * 1000

	// An ISO 8601 duration with hours and minutes (PT1M30S).
	const iso = /^\s*P(?:T(?:(\d+(?:\.\d*)?)H)?(?:(\d+(?:\.\d*)?)M)?(?:(\d+(?:\.\d*)?)S)?)\s*$/u.exec(value)

	return iso === null ? undefined : (Number(iso[1] ?? 0) * 3600 + Number(iso[2] ?? 0) * 60 + Number(iso[3] ?? 0)) * 1000
}

// The way a slide moves (ECMA-376 ST_Transition*DirectionType) entering from a SMIL edge or corner.
const MOVES: Readonly<Record<string, string>> = {
	fromRight: "l",
	fromLeft: "r",
	fromBottom: "u",
	fromTop: "d",
	fromBottomRight: "lu",
	fromBottomLeft: "ru",
	fromTopRight: "ld",
	fromTopLeft: "rd"
}

function kindOf(type: string, subtype: string, direction: string): { kind: string; options: Record<string, string | boolean> } {
	const reverse = direction === "reverse"

	switch (type) {
		case "fade":
			return subtype === "fadeOverColor" || subtype === "fadeToColor"
				? { kind: "fade", options: { thruBlk: true } }
				: { kind: "fade", options: {} }
		case "barWipe":
			return { kind: "wipe", options: { dir: subtype === "topToBottom" ? (reverse ? "u" : "d") : reverse ? "l" : "r" } }
		case "pushWipe":
			return subtype === "combHorizontal" || subtype === "combVertical"
				? { kind: "comb", options: { dir: subtype === "combVertical" ? "vert" : "horz" } }
				: { kind: "push", options: { dir: MOVES[subtype] ?? "r" } }
		case "slideWipe":
			// The eight directions of cover and pull (ST_TransitionEightDirectionType).
			return { kind: reverse ? "pull" : "cover", options: { dir: MOVES[subtype] ?? "r" } }
		case "irisWipe":
		case "ellipseWipe":
		case "starWipe":
			return { kind: type === "irisWipe" && subtype === "rectangle" ? "zoom" : "circle", options: {} }
		case "clockWipe":
			return { kind: "wheel", options: { spokes: subtype === "fourBlade" ? "4" : "1" } }
		case "fanWipe":
		case "pinWheelWipe":
		case "singleSweepWipe":
		case "doubleFanWipe":
		case "doubleSweepWipe":
		case "saloonDoorWipe":
		case "windshieldWipe":
			return { kind: "wedge", options: {} }
		case "fourBoxWipe":
		case "boxWipe":
			return { kind: "zoom", options: {} }
		case "blindsWipe":
			return { kind: "blinds", options: { dir: subtype === "horizontal" ? "horz" : "vert" } }
		case "checkerBoardWipe":
			return { kind: "checker", options: { dir: subtype === "across" ? "horz" : "vert" } }
		case "randomBarWipe":
			return { kind: "randomBar", options: { dir: subtype === "horizontal" ? "horz" : "vert" } }
		case "dissolve":
			return { kind: "dissolve", options: {} }
		case "random":
			return { kind: "random", options: {} }
		case "waterfallWipe":
		case "snakeWipe":
		case "spiralWipe":
		case "parallelSnakesWipe":
		case "boxSnakesWipe":
			return { kind: "strips", options: {} }
		case "zoom":
			return { kind: "zoom", options: {} }
		default:
			return { kind: "cut", options: {} }
	}
}

// The transition of a page: its style's properties, else (when written) its transition filter; undefined when the
// page has none and advances on click.
export function readTransition(
	page: ReadonlyMap<string, string>,
	filter: ReadonlyMap<string, string> | undefined,
	sound?: Transition["sound"]
): Transition | undefined {
	const source = filter ?? page
	const type = source.get("smil:type")
	const subtype = source.get("smil:subtype") ?? ""
	const direction = source.get("smil:direction") ?? "forward"
	const advanceType = page.get("presentation:transition-type") ?? "manual"
	const after = seconds(page.get("presentation:duration"))
	const automatic = advanceType === "automatic" || advanceType === "semi-automatic"
	const speed = page.get("presentation:transition-speed")
	const duration = seconds(source.get("smil:dur")) ?? (speed === undefined ? undefined : SPEEDS[speed])

	if (type === undefined && !automatic) return undefined

	const extended = type === undefined ? undefined : kindFromOdf(type, subtype, source.get("smil:fadeColor"))
	const mapped = extended ?? (type === undefined ? { kind: "cut", options: {} } : kindOf(type, subtype, direction))
	const options: Record<string, string | number | boolean> = { ...mapped.options }

	if (type !== undefined) {
		options["smilType"] = type
		if (subtype !== "") options["smilSubtype"] = subtype
		if (direction !== "forward") options["smilDirection"] = direction
		const color = source.get("smil:fadeColor")

		if (color !== undefined) options["smilFadeColor"] = color
	}

	return {
		kind: mapped.kind,
		namespace: extended?.namespace ?? "p",
		options,
		...(duration === undefined ? {} : { durationMs: Math.round(duration) }),
		...(speed === "slow"
			? { speed: "slow" as const }
			: speed === "fast"
				? { speed: "fast" as const }
				: speed === "medium"
					? { speed: "med" as const }
					: {}),
		advance: { onClick: advanceType !== "automatic", ...(automatic && after !== undefined ? { afterMs: Math.round(after) } : {}) },
		...(sound === undefined ? {} : { sound })
	}
}
