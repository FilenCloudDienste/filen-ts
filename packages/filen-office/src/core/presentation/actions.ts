import type { Action, SlideRef } from "./model"

// Classification of PresentationML hyperlink actions (a:hlinkClick / a:hlinkHover on shapes and runs, ECMA-376
// Part 1 §21.1.2.3.5 and the ppaction:// verbs of §19.7 / MS-OI29500): what the show and the editor may do with
// them. Only http, https and mailto become links, opened after a click with the host shown; internal jumps and
// custom shows stay inside the deck; programs, macros, OLE verbs, files, other presentations and unknown schemes
// are refused: inert, kept in the file byte for byte, shown with their reason. Undefined means no action
// (ppaction://noaction, an empty link, a jump to a slide the deck does not have).

export interface ActionInput {
	// The action attribute ("ppaction://hlinksldjump"...), absent for a plain hyperlink.
	readonly action?: string
	// The r:id relationship's target, when the link has one.
	readonly target?: { readonly external: boolean; readonly target: string; readonly partName?: string }
}

export interface ActionContext {
	// The slide a part name is, when it is one of the deck's slides.
	slideOf(partName: string): SlideRef | undefined
}

const SHOW_JUMPS: Readonly<Record<string, Extract<Action, { kind: "internal" }>["jump"]>> = {
	nextslide: "next",
	previousslide: "previous",
	firstslide: "first",
	lastslide: "last",
	lastslideviewed: "lastViewed",
	endshow: "end"
}

const URL_SCHEMES: ReadonlySet<string> = new Set(["http", "https", "mailto"])

// The query of a ppaction verb ("customshow?id=0&return=true"), names lower-cased.
function query(verb: string): Map<string, string> {
	const out = new Map<string, string>()
	const at = verb.indexOf("?")

	if (at < 0) return out

	for (const pair of verb.slice(at + 1).split("&")) {
		const equals = pair.indexOf("=")
		const name = (equals < 0 ? pair : pair.slice(0, equals)).trim().toLowerCase()

		if (name !== "" && !out.has(name)) out.set(name, equals < 0 ? "" : pair.slice(equals + 1).trim())
	}

	return out
}

function hasControlOrSpace(text: string): boolean {
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index)

		if (code <= 0x20 || code === 0x7f) return true
	}

	return false
}

// A link target's verdict: a url for http, https and mailto, else refused as a file (file:, UNC, a relative or
// drive path) or a scheme (javascript:, data:, anything else).
export function classifyHref(href: string): Action {
	const trimmed = href.trim()
	const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/u.exec(trimmed)?.[1]?.toLowerCase()

	if (scheme !== undefined && URL_SCHEMES.has(scheme) && !hasControlOrSpace(trimmed)) {
		if (scheme === "mailto" || /^https?:\/\/[^/?#\s]+/iu.test(trimmed)) return { kind: "url", href: trimmed }
	}

	// A one-letter "scheme" is a drive letter (C:\...).
	if (scheme === undefined || scheme === "file" || scheme.length === 1) return { kind: "refused", what: "file", raw: href }

	return { kind: "refused", what: "scheme", raw: href }
}

export function classifyAction(input: ActionInput, context: ActionContext): Action | undefined {
	const verb = (input.action ?? "").trim()
	const target = input.target

	if (verb === "") {
		if (target === undefined || target.target === "") return undefined
		if (!target.external) {
			const slide = target.partName === undefined ? undefined : context.slideOf(target.partName)

			// A plain internal link is a slide jump when it names a slide (some writers omit the verb).
			return slide === undefined ? { kind: "refused", what: "file", raw: target.target } : { kind: "slide", slide }
		}

		return classifyHref(target.target)
	}

	const lower = verb.toLowerCase()
	const name = lower.startsWith("ppaction://") ? (lower.slice("ppaction://".length).split("?")[0] ?? "") : undefined

	if (name === undefined) {
		// Not a ppaction verb: an unknown scheme in the action attribute.
		return { kind: "refused", what: "scheme", raw: verb }
	}

	switch (name) {
		case "noaction":
			return undefined
		case "media":
			return { kind: "media" }
		case "hlinksldjump": {
			if (target === undefined || target.external || target.partName === undefined) return undefined

			const slide = context.slideOf(target.partName)

			return slide === undefined ? undefined : { kind: "slide", slide }
		}
		case "hlinkshowjump": {
			const jump = SHOW_JUMPS[(query(lower).get("jump") ?? "").toLowerCase()]

			return jump === undefined ? undefined : { kind: "internal", jump }
		}
		case "customshow": {
			const parameters = query(verb)
			const id = Number(parameters.get("id") ?? "")

			if (!Number.isInteger(id) || id < 0) return undefined

			return { kind: "customShow", id, returnAfter: (parameters.get("return") ?? "").toLowerCase() === "true" }
		}
		case "program":
			return { kind: "refused", what: "program", raw: target?.target ?? verb }
		case "macro":
			return { kind: "refused", what: "macro", raw: verb }
		case "ole":
			return { kind: "refused", what: "ole", raw: verb }
		case "hlinkfile":
		case "hlinkpres":
			return { kind: "refused", what: "file", raw: target?.target ?? verb }
		default:
			return { kind: "refused", what: "scheme", raw: verb }
	}
}
