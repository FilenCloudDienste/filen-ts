import type { CommonTimeNode, PresetClass, TimeEventName, TimeNodeType, TimeValue } from "./model"

// The ECMA-376 Part 1 §19.5 value vocabulary of p:timing, shared by the pptx reader (core/pptx/read/timing.ts), the
// pptx emit and the ODF mapping: times (ST_TLTime: milliseconds or "indefinite"), the 1/100,000 fractions
// (ST_PositiveFixedPercentage and friends: an integer in Transitional, "50%" in Strict), and the enumerations the model
// keeps as strings. Anything outside an enumeration reads as absent and stays in the source.

export function parseTime(text: string | undefined): TimeValue | undefined {
	if (text === undefined) return undefined

	const value = text.trim()

	if (value === "indefinite") return "indefinite"
	if (!/^-?\d+(?:\.\d+)?$/u.test(value)) return undefined

	const number = Number(value)

	return Number.isFinite(number) ? number : undefined
}

export function formatTime(value: TimeValue): string {
	return value === "indefinite" ? "indefinite" : String(Math.round(value))
}

// A percentage in 1/1,000 of a percent: "50000" (Transitional) or "50%" (Strict).
export function parsePercent(text: string | undefined): number | undefined {
	if (text === undefined) return undefined

	const value = text.trim()
	const strict = value.endsWith("%")
	const number = Number(strict ? value.slice(0, -1) : value)

	if (value === "" || !Number.isFinite(number)) return undefined

	return strict ? Math.round(number * 1000) : number
}

export function formatInteger(value: number): string {
	return String(Math.round(value))
}

const NODE_TYPES: ReadonlySet<string> = new Set<TimeNodeType>([
	"clickEffect",
	"withEffect",
	"afterEffect",
	"mainSeq",
	"interactiveSeq",
	"clickPar",
	"withGroup",
	"afterGroup",
	"tmRoot"
])

const PRESET_CLASSES: ReadonlySet<string> = new Set<PresetClass>(["entr", "exit", "emph", "path", "verb", "mediacall"])

const EVENTS: ReadonlySet<string> = new Set<TimeEventName>([
	"onBegin",
	"onEnd",
	"begin",
	"end",
	"onClick",
	"onDblClick",
	"onMouseOver",
	"onMouseOut",
	"onNext",
	"onPrev",
	"onStopAudio",
	"onMediaBookmark"
])

export function nodeTypeOf(text: string | undefined): TimeNodeType | undefined {
	return text !== undefined && NODE_TYPES.has(text) ? (text as TimeNodeType) : undefined
}

export function presetClassOf(text: string | undefined): PresetClass | undefined {
	return text !== undefined && PRESET_CLASSES.has(text) ? (text as PresetClass) : undefined
}

export function eventOf(text: string | undefined): TimeEventName | undefined {
	return text !== undefined && EVENTS.has(text) ? (text as TimeEventName) : undefined
}

export function oneOf<T extends string>(text: string | undefined, values: readonly T[]): T | undefined {
	return text !== undefined && (values as readonly string[]).includes(text) ? (text as T) : undefined
}

// The p:cTn attributes the model holds (everything else on a cTn stays as its source).
export const CTN_MODELED: ReadonlySet<string> = new Set([
	"id",
	"presetID",
	"presetClass",
	"presetSubtype",
	"nodeType",
	"grpId",
	"fill",
	"restart",
	"dur",
	"repeatCount",
	"repeatDur",
	"spd",
	"accel",
	"decel",
	"autoRev",
	"syncBehavior",
	"masterRel"
])

// The cTn attribute values of `ctn` in schema order (CT_TLCommonTimeNodeData).
export function ctnAttributes(ctn: CommonTimeNode): readonly (readonly [string, string])[] {
	const out: [string, string][] = [["id", formatInteger(ctn.id)]]
	const push = (name: string, value: string | undefined): void => {
		if (value !== undefined) out.push([name, value])
	}

	push("presetID", ctn.presetID === undefined ? undefined : formatInteger(ctn.presetID))
	push("presetClass", ctn.presetClass)
	push("presetSubtype", ctn.presetSubtype === undefined ? undefined : formatInteger(ctn.presetSubtype))
	push("dur", ctn.dur === undefined ? undefined : formatTime(ctn.dur))
	push("repeatCount", ctn.repeatCount === undefined ? undefined : formatTime(ctn.repeatCount))
	push("repeatDur", ctn.repeatDur === undefined ? undefined : formatTime(ctn.repeatDur))
	push("spd", ctn.spd === undefined ? undefined : formatInteger(ctn.spd))
	push("accel", ctn.accel === undefined ? undefined : formatInteger(ctn.accel))
	push("decel", ctn.decel === undefined ? undefined : formatInteger(ctn.decel))
	push("autoRev", ctn.autoRev === undefined ? undefined : ctn.autoRev ? "1" : "0")
	push("restart", ctn.restart)
	push("fill", ctn.fill)
	push("syncBehavior", ctn.syncBehavior)
	push("masterRel", ctn.masterRel)
	push("grpId", ctn.grpId === undefined ? undefined : formatInteger(ctn.grpId))
	push("nodeType", ctn.nodeType)

	return out
}
