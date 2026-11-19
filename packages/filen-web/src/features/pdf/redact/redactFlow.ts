import {
	verifiedTerms,
	type RedactionFailure,
	type RedactionFinding,
	type RedactionQuery,
	type RedactionTerm
} from "@filen/office/core/pdfedit/redactVerify"
import type { PdfEditSessionModel } from "@filen/office/react/pdfedit"
import { withPdfSession, type PdfToolContext } from "@/features/pdf/tools/registry"
import { isRedactionRefusal, markedFindings, markedPages, type RedactionDestination } from "@/features/pdf/redact/redaction.logic"
import { log } from "@/lib/log"

// Applying the marks and saving the result, as the Apply redactions dialog runs it: every page with marks applied
// (one undo step each), the searched terms cut from everything outside page content, the optional sanitize, then the
// save (a full rewrite the redaction verifier checks before anything is uploaded) as a copy or a new version. When the
// save does not happen (the check failed, the upload failed, it was cancelled) the applied steps are undone, so the
// marks are back for another try and nothing unverified stays in the document; after a copy too, so the document goes
// on as it was (its marks back, nothing unsaved but them), the redacted file beside it.

// The Find & redact searches of one editor session: the verifier is told the terms whose every finding stayed marked.
// Each distinct query once (by its terms with their options, and its presets), in the order first searched: Apply
// searches the whole document again per query.
const searches = new WeakMap<PdfEditSessionModel, Map<string, RedactionQuery>>()

function queryKey(query: RedactionQuery): string {
	return JSON.stringify([query.terms.map(term => [term.text, term.matchCase, term.wholeWord]), query.presets])
}

export function rememberSearch(session: PdfEditSessionModel, query: RedactionQuery): void {
	const known = searches.get(session)

	if (known === undefined) searches.set(session, new Map([[queryKey(query), query]]))
	else known.set(queryKey(query), query)
}

// One Find & redact search: its findings, or null when the engine failed to search (logged; never "no matches"). Only
// a search that ran is remembered for the verifier.
export function findForRedaction(session: PdfEditSessionModel, query: RedactionQuery): Promise<readonly RedactionFinding[] | null> {
	return session.engine.call("redactFind", { query }).then(
		found => {
			rememberSearch(session, query)

			return found
		},
		(error: unknown) => {
			log.error("pdf", "find & redact search failed", { error })

			return null
		}
	)
}

const REDACTION_STEPS: ReadonlySet<string> = new Set(["redact.apply", "redact.scrub", "redact.sanitize"])
// The step "Flatten annotations" adds before a version save writes (flattenedFirst).
const FLATTEN_STEP = "annotations.flatten"

export interface ApplyRedactionsRequest {
	readonly sanitize: boolean
	readonly removeAnnotations: boolean
	readonly destination: RedactionDestination
	// Words a copy's name suffix ("redacted", "redacted 2").
	readonly copySuffix: (number: number) => string
}

export type ApplyRedactionsOutcome =
	| { readonly kind: "saved"; readonly copy: string | null }
	// The written file failed the redaction check: nothing was uploaded.
	| { readonly kind: "refused"; readonly failure: RedactionFailure }
	| { readonly kind: "failed"; readonly error: unknown }
	// Nothing was marked ("nothing"), or the save did not start ("save": told to the user).
	| { readonly kind: "cancelled"; readonly reason: "nothing" | "save" }

// The terms searched in this session that the marks now cover everywhere they were found.
async function termsToVerify(session: PdfEditSessionModel): Promise<RedactionTerm[]> {
	const queries = [...(searches.get(session)?.values() ?? [])]

	if (queries.length === 0) return []

	const marks = await session.engine.call("redactMarks", {})
	const terms = new Map<string, RedactionTerm>()

	for (const query of queries) {
		const findings = await session.engine.call("redactFind", { query })

		for (const term of verifiedTerms(query.terms, findings, markedFindings(findings, marks)))
			terms.set(`${String(term.matchCase)}${String(term.wholeWord)}${term.text}`, term)
	}

	return [...terms.values()]
}

// The marks applied page by page, then scrub and sanitize. Resolves how many steps were made (0: nothing applied).
async function applySteps(session: PdfEditSessionModel, request: ApplyRedactionsRequest): Promise<number> {
	const terms = await termsToVerify(session)
	const pages = markedPages(await session.engine.call("redactMarks", {}))

	if (pages.length === 0) return 0

	for (const page of pages) {
		await session.dispatch("redact.apply", { page, removeAnnotations: request.removeAnnotations, terms, sanitize: request.sanitize })
	}

	if (terms.length > 0) await session.dispatch("redact.scrub", { terms })
	if (request.sanitize) await session.dispatch("redact.sanitize", {})

	return pages.length + (terms.length > 0 ? 1 : 0) + (request.sanitize ? 1 : 0)
}

function isRedactionStep(label: string | null): boolean {
	return label !== null && REDACTION_STEPS.has(label)
}

// Undoes the redaction steps at the top of the history (the marks come back); `count` of them at once when known (a
// save wrote the document since, so the journal cannot take them back: one rebuild instead of one per step). Without a
// count, a flatten step right above them (the failed version save's own) goes with them; one further down (an earlier
// save's) stays.
async function undoSteps(session: PdfEditSessionModel, count: number | null): Promise<void> {
	if (count !== null) {
		await session.undo(count)

		return
	}

	const top = (): string | null => session.getSnapshot().state.undoLabel

	if (top() === FLATTEN_STEP) {
		await session.undo()

		// No redaction step under it: it was not the save's, and is put back.
		if (!isRedactionStep(top())) {
			await session.redo()

			return
		}
	}

	for (let guard = 0; guard < 100_000; guard++) {
		if (!isRedactionStep(top())) return

		await session.undo()
	}
}

// The redaction steps undone on the editor session; an editor that is gone has nothing left to undo.
function undoRedaction(context: PdfToolContext, count: number | null = null): Promise<void> {
	return withPdfSession(context, session => undoSteps(session, count)).catch((error: unknown) => {
		log.warn("pdf", "undoing the redaction steps failed", { error })
	})
}

export async function applyRedactions(context: PdfToolContext, request: ApplyRedactionsRequest): Promise<ApplyRedactionsOutcome> {
	const applied = await withPdfSession(context, session => applySteps(session, request)).then(
		value => ({ ok: true as const, value }),
		(error: unknown) => ({ ok: false as const, error })
	)

	if (!applied.ok) {
		await undoRedaction(context)

		return { kind: "failed", error: applied.error }
	}

	if (applied.value === 0) return { kind: "cancelled", reason: "nothing" }

	const saved = await context.host.save(
		request.destination.kind === "copy" ? { kind: "copy", suffix: request.copySuffix } : { kind: "version" }
	)

	if (saved.status === "saved" && request.destination.kind !== "copy") return { kind: "saved", copy: null }

	// A copy's save holds no other step than the redaction's (changes wait for it): all of them at once. A version's
	// may add its own flatten step on top (Flatten annotations), undone with them, so they are found by name.
	await undoRedaction(context, request.destination.kind === "copy" ? applied.value : null)

	if (saved.status === "saved") return { kind: "saved", copy: saved.name }

	if (saved.status === "cancelled") return { kind: "cancelled", reason: "save" }

	return isRedactionRefusal(saved.error) ? { kind: "refused", failure: saved.error.failure } : { kind: "failed", error: saved.error }
}
