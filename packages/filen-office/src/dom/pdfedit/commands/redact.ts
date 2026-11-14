import { invertMatrix, type PdfMatrix } from "../../../core/pdfedit/matrix"
import {
	hiddenTerms,
	REDACTION_PRESETS,
	type RedactionManifest,
	type RedactionPreset,
	type RedactionRegion,
	type RedactionTerm,
	transformRect,
	type RedactQuad,
	type RedactRect
} from "../../../core/pdfedit/redactVerify"
import { PdfEngineRefusal } from "../context"
import type { LoggedStep } from "../editSession"
import { applyPageRedactions } from "../redact/apply"
import { markArea, markPage, markText, removeRedactionMark } from "../redact/marks"
import { sanitizeForRedaction } from "../redact/sanitize"
import { scrubTermsForRedaction } from "../redact/scrub"
import { isIndex, isRecord, isText, type PdfCommand, type PdfCommandContext, type PdfCommandTable } from "./types"

// True redaction as commands. Marks are Redact annotations (nothing is removed until they are applied); applying is
// one page per command (its undo step), then the searched terms are cut from everything outside page content
// (scrub), then the optional sanitize; every apply, scrub and sanitize removes content. Coordinates are MuPDF page
// space (points, origin top left, y down). Each applied page's regions are kept with the command's logged arguments,
// so the save that follows knows what the verifier must find gone (redactionManifest), across undo, redo and rebuilds.

const MAX_QUADS = 10_000
const MAX_FINDINGS = 100_000
const MAX_TERMS = 1000
const MAX_TERM = 1000

export interface PdfRedactFinding {
	readonly page: number
	readonly quads: readonly RedactQuad[]
}

export interface PdfRedactCommands {
	"redact.markText": { readonly page: number; readonly quads: readonly RedactQuad[] }
	"redact.markArea": { readonly page: number; readonly rect: RedactRect }
	"redact.markPage": { readonly page: number }
	// Find & redact's chosen findings, each a text mark.
	"redact.markFindings": { readonly findings: readonly PdfRedactFinding[] }
	"redact.removeMark": { readonly page: number; readonly id: number }
	// Applies every mark of the page (consumes them). `terms` and `sanitize` are what the whole redaction promises (the
	// terms found nowhere, the file sanitized): carried by each applied page so the verifier checks them even where the
	// scrub or sanitize step changed nothing (and so made no step).
	"redact.apply": {
		readonly page: number
		readonly removeAnnotations: boolean
		readonly terms: readonly RedactionTerm[]
		readonly sanitize: boolean
	}
	// The searched terms cut from annotations, fields, bookmarks, names and every other string outside page content.
	"redact.scrub": { readonly terms: readonly RedactionTerm[] }
	"redact.sanitize": Record<string, never>
}

function isFiniteNumbers(value: unknown, length: number): value is readonly number[] {
	return Array.isArray(value) && value.length === length && value.every(item => typeof item === "number" && Number.isFinite(item))
}

function isQuad(value: unknown): value is RedactQuad {
	return isFiniteNumbers(value, 8)
}

function isRect(value: unknown): value is RedactRect {
	return isFiniteNumbers(value, 4)
}

function isQuads(value: unknown): value is readonly RedactQuad[] {
	return Array.isArray(value) && value.length > 0 && value.length <= MAX_QUADS && value.every(isQuad)
}

function isTerm(value: unknown): value is RedactionTerm {
	return (
		isRecord(value) &&
		isText(value["text"], MAX_TERM) &&
		value["text"].trim().length > 0 &&
		typeof value["matchCase"] === "boolean" &&
		typeof value["wholeWord"] === "boolean"
	)
}

export function isRedactionTerms(value: unknown): value is readonly RedactionTerm[] {
	return Array.isArray(value) && value.length <= MAX_TERMS && value.every(isTerm)
}

export function isRedactionPresets(value: unknown): value is readonly RedactionPreset[] {
	return Array.isArray(value) && value.every(item => REDACTION_PRESETS.some(preset => preset === item))
}

function noArgs(args: unknown): Record<string, never> | null {
	return isRecord(args) && Object.keys(args).length === 0 ? {} : null
}

function checkPage(context: PdfCommandContext, page: number): void {
	if (page >= context.document.countPages()) throw new PdfEngineRefusal("badRequest", "no such page")
}

function pageNumber(document: PdfCommandContext["document"], page: number): number {
	const object = document.findPage(page)

	if (!object.isIndirect()) throw new PdfEngineRefusal("failed", "the page is not an object")

	return object.asIndirect()
}

// What a step redacted, by the logged arguments of its command: each page's object (found again by number at save
// time, wherever the page moved) and its regions in the page's user space (where a later crop or rotation does not
// move them). A rebuild runs the command again on the same arguments and records the same.
interface RedactedPage {
	readonly pageObject: number
	readonly regions: readonly RedactionRegion[]
	// The words the marks covered (AppliedRedactions.hidden).
	readonly hidden: readonly string[]
}

// What a command redacted on one page (0-based, as now), in its page space as it is now.
export interface RedactedRegions {
	readonly page: number
	readonly regions: readonly RedactionRegion[]
	readonly hidden: readonly string[]
}

// The transform from a page's user space to its page space (MuPDF's: crop box and rotation applied).
function pageTransform(document: PdfCommandContext["document"], page: number): PdfMatrix {
	const loaded = document.loadPage(page)

	try {
		return loaded.getTransform()
	} finally {
		loaded.destroy()
	}
}

const redactedBy = new WeakMap<object, readonly RedactedPage[]>()

// The commands whose steps redact regions, each recording them with recordRedaction: an applied page, and a crop that
// deletes what lies outside it.
const REGION_STEPS: ReadonlySet<string> = new Set(["redact.apply", "crop.removeOutside"])

// Records what a command run with `args` redacted on each page of `document`.
export function recordRedaction(document: PdfCommandContext["document"], args: object, pages: readonly RedactedRegions[]): void {
	redactedBy.set(
		args,
		pages.map(({ page, regions, hidden }) => {
			const toUser = invertMatrix(pageTransform(document, page))

			if (toUser === null) throw new PdfEngineRefusal("failed", "the page has no area")

			return {
				pageObject: pageNumber(document, page),
				regions: regions.map(region => ({ ...region, rect: transformRect(toUser, region.rect) })),
				hidden
			}
		})
	)
}

const APPLY: PdfCommand<PdfRedactCommands["redact.apply"]> = {
	tool: "content",
	removesContent: true,
	parse: args =>
		isRecord(args) &&
		isIndex(args["page"]) &&
		typeof args["removeAnnotations"] === "boolean" &&
		isRedactionTerms(args["terms"]) &&
		typeof args["sanitize"] === "boolean"
			? { page: args["page"], removeAnnotations: args["removeAnnotations"], terms: args["terms"], sanitize: args["sanitize"] }
			: null,
	run: (context, args) => {
		checkPage(context, args.page)

		const result = applyPageRedactions(context.mupdf, context.document, args.page, { removeAnnotations: args.removeAnnotations })

		recordRedaction(context.document, args, [{ page: args.page, regions: result.regions, hidden: result.hidden }])

		return result.pages
	}
}

export const REDACT_COMMANDS: PdfCommandTable<PdfRedactCommands> = {
	"redact.markText": {
		tool: "content",
		parse: args =>
			isRecord(args) && isIndex(args["page"]) && isQuads(args["quads"]) ? { page: args["page"], quads: args["quads"] } : null,
		run: (context, args) => {
			checkPage(context, args.page)
			markText(context.page(args.page), args.quads)

			return [args.page]
		}
	},
	"redact.markArea": {
		tool: "content",
		parse: args =>
			isRecord(args) && isIndex(args["page"]) && isRect(args["rect"]) ? { page: args["page"], rect: args["rect"] } : null,
		run: (context, args) => {
			checkPage(context, args.page)

			const [x0, y0, x1, y1] = args.rect

			if (Math.abs(x1 - x0) < 1 || Math.abs(y1 - y0) < 1) throw new PdfEngineRefusal("badRequest", "the area is empty")

			markArea(context.page(args.page), args.rect)

			return [args.page]
		}
	},
	"redact.markPage": {
		tool: "content",
		parse: args => (isRecord(args) && isIndex(args["page"]) ? { page: args["page"] } : null),
		run: (context, args) => {
			checkPage(context, args.page)
			markPage(context.page(args.page))

			return [args.page]
		}
	},
	"redact.markFindings": {
		tool: "content",
		parse: args => {
			if (!isRecord(args) || !Array.isArray(args["findings"])) return null

			const findings: unknown[] = args["findings"]

			if (findings.length === 0 || findings.length > MAX_FINDINGS) return null

			const parsed: PdfRedactFinding[] = []

			for (const finding of findings) {
				if (!isRecord(finding) || !isIndex(finding["page"]) || !isQuads(finding["quads"])) return null

				parsed.push({ page: finding["page"], quads: finding["quads"] })
			}

			return { findings: parsed }
		},
		run: (context, args) => {
			const pages = new Set<number>()

			for (const finding of args.findings) {
				checkPage(context, finding.page)
				markText(context.page(finding.page), finding.quads)
				pages.add(finding.page)
			}

			return [...pages].sort((a, b) => a - b)
		}
	},
	"redact.removeMark": {
		tool: "content",
		target: "id",
		parse: args => (isRecord(args) && isIndex(args["page"]) && isIndex(args["id"]) ? { page: args["page"], id: args["id"] } : null),
		run: (context, args) => {
			checkPage(context, args.page)

			if (!removeRedactionMark(context.page(args.page), args.id)) throw new PdfEngineRefusal("badRequest", "no such mark")

			return [args.page]
		}
	},
	"redact.apply": APPLY,
	"redact.scrub": {
		tool: "content",
		removesContent: true,
		parse: args => (isRecord(args) && isRedactionTerms(args["terms"]) ? { terms: args["terms"] } : null),
		run: (context, args) => scrubTermsForRedaction(context.document, args.terms)
	},
	"redact.sanitize": {
		tool: "content",
		removesContent: true,
		parse: noArgs,
		run: context => sanitizeForRedaction(context.document)
	}
}

function termKey(term: RedactionTerm): string {
	return `${term.matchCase ? "1" : "0"}${term.wholeWord ? "1" : "0"}${term.text}`
}

// Whether any of the steps removes content under the redaction rules (an apply, a scrub, a sanitize, removing what lies
// outside a crop): only a plain save, whose verifier checks them, may write them.
export function redactsContent(steps: readonly LoggedStep[]): boolean {
	return steps.some(step => REGION_STEPS.has(step.label) || step.label === "redact.scrub" || step.label === "redact.sanitize")
}

// What the steps in the document redacted, for the verifier of the file a save writes; null when none redacted
// anything (no apply, scrub or sanitize). Terms and sanitize count from the applied pages' promises and from scrub and
// sanitize steps alike: a check that would fail is never skipped because its step was undone. `pageOf` finds a page's index by its object number now; regions of a page
// since deleted are gone with it. Throws when an applied page's regions are not known (never: every apply records).
export function redactionManifest(
	document: PdfCommandContext["document"],
	steps: readonly LoggedStep[],
	pageOf: (pageObject: number) => number | undefined
): RedactionManifest | null {
	const regions: RedactionRegion[] = []
	const terms = new Map<string, RedactionTerm>()
	const hidden = new Set<string>()
	let redacted = false
	let sanitized = false
	let annotationsRemoved = true

	for (const step of steps) {
		if (REGION_STEPS.has(step.label)) {
			redacted = true

			for (const args of step.args) {
				const record = typeof args === "object" && args !== null ? redactedBy.get(args) : undefined

				if (record === undefined || !isRecord(args)) throw new PdfEngineRefusal("failed", "an applied redaction is not known")

				if (step.label === "redact.apply") {
					if (args["removeAnnotations"] === false) annotationsRemoved = false
					if (args["sanitize"] === true) sanitized = true
					if (isRedactionTerms(args["terms"])) for (const term of args["terms"]) terms.set(termKey(term), term)
				}

				for (const done of record) {
					// Kept even when the page is gone since: its tags may not be.
					for (const word of done.hidden) hidden.add(word)

					const page = pageOf(done.pageObject)

					if (page === undefined) continue

					// Into the page space the verifier reads the saved page in (its crop and rotation now).
					const toPage = pageTransform(document, page)

					for (const region of done.regions) regions.push({ ...region, page, rect: transformRect(toPage, region.rect) })
				}
			}
		} else if (step.label === "redact.scrub") {
			redacted = true

			for (const args of step.args) {
				if (isRecord(args) && isRedactionTerms(args["terms"])) for (const term of args["terms"]) terms.set(termKey(term), term)
			}
		} else if (step.label === "redact.sanitize") {
			redacted = true
			sanitized = true
		}
	}

	return redacted ? { regions, terms: [...terms.values()], hidden: hiddenTerms(hidden), sanitized, annotationsRemoved } : null
}
