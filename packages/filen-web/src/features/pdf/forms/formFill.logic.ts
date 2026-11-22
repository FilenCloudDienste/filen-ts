import { FORM_FILL_LABEL_MAX_CHARS, FORM_FILL_MAX_FIELDS, type FormFillEntry, type FormFillField } from "@filen/shared/assistant"
import type { PdfViewport } from "@filen/office/dom/pdf"
import type { PdfFieldValue } from "@filen/office/dom/pdfedit/fillSign"
import type { PdfEditSessionModel } from "@filen/office/react/pdfedit"
import { engineFields, fieldEmpty, type FormOverlaySession, type OverlayField } from "@/features/pdf/session/fieldOverlay.logic"

// Filling the page in view from details the user types (the assistant's form fill): which of the page's fields are
// offered, what names each (fieldLabels), and Accept as one gesture of the editor (one undo step). Boxes are in the page's
// viewport at scale 1 (CSS px, top left origin, the same space for both engines' fields and text), about a point each.

export interface Box {
	readonly left: number
	readonly top: number
	readonly right: number
	readonly bottom: number
}

// A run of the page's text (a pdf.js text item, or the editor's line) in that space.
export interface TextRun {
	readonly text: string
	readonly box: Box
}

// The smallest field offered (a field this small, or off the page, is how a hostile form would catch data unseen).
const MIN_FIELD_SIZE = 4
// How far a label left of a field (same line) or above it may be.
const LABEL_LEFT_MAX = 200
const LABEL_ABOVE_MAX = 24

export interface FormFillCandidate {
	readonly field: OverlayField
	readonly box: Box
}

// Fields the page shows that the assistant does not fill: checkboxes and radio buttons (the user ticks them), those
// past the request's limit, and those nothing names.
export interface FormFillLeftOut {
	readonly field: OverlayField
	readonly reason: "tick" | "limit" | "unlabeled"
	readonly label: string
}

export interface FormFillPage {
	// Offered, in tab order, labelled: what the request numbers.
	readonly offered: readonly (FormFillCandidate & { readonly fill: FormFillField })[]
	readonly left: readonly FormFillLeftOut[]
}

// A rectangle of the page's user space (two corners) in the viewport's space.
export function viewportBox(viewport: PdfViewport, x1: number, y1: number, x2: number, y2: number): Box {
	const [ax, ay] = viewport.convertToViewportPoint(x1, y1).map(Number)
	const [bx, by] = viewport.convertToViewportPoint(x2, y2).map(Number)

	return {
		left: Math.min(ax ?? 0, bx ?? 0),
		top: Math.min(ay ?? 0, by ?? 0),
		right: Math.max(ax ?? 0, bx ?? 0),
		bottom: Math.max(ay ?? 0, by ?? 0)
	}
}

// The page box itself.
export function pageBox(viewport: PdfViewport): Box {
	return { left: 0, top: 0, right: viewport.width, bottom: viewport.height }
}

// The page's text items (getTextContent: pdf.js's, or the editor's in the same shape) as runs: each item's box from its
// baseline origin to its width and font height.
export function textRuns(items: readonly unknown[], viewport: PdfViewport): TextRun[] {
	return items.flatMap(item => {
		if (typeof item !== "object" || item === null) return []

		const text: unknown = Reflect.get(item, "str")
		const transform: unknown = Reflect.get(item, "transform")
		const width: unknown = Reflect.get(item, "width")
		const height: unknown = Reflect.get(item, "height")

		if (typeof text !== "string" || text.trim().length === 0 || !Array.isArray(transform)) return []

		const x = Number(transform[4])
		const y = Number(transform[5])
		const w = typeof width === "number" ? width : 0
		const h = typeof height === "number" && height > 0 ? height : Math.hypot(Number(transform[2]), Number(transform[3]))

		return Number.isFinite(x) && Number.isFinite(y) ? [{ text, box: viewportBox(viewport, x, y, x + w, y + h) }] : []
	})
}

function inside(box: Box, page: Box): boolean {
	return box.left >= page.left - 1 && box.top >= page.top - 1 && box.right <= page.right + 1 && box.bottom <= page.bottom + 1
}

// Whether the assistant may fill a field: a text field or a choice, not read-only (a signature's lock included),
// password or filled already (a value, or text typed and not committed), and a box of a visible size on the page.
// Hidden widgets never reach here (both engines' field lists leave them out).
export function formFillEligible(candidate: FormFillCandidate, page: Box, form: Pick<FormOverlaySession, "draft">): boolean {
	const { field, box } = candidate

	return (
		(field.kind === "text" || field.kind === "combo" || field.kind === "list") &&
		!field.readOnly &&
		!field.password &&
		fieldEmpty(field) &&
		form.draft(field.id) === undefined &&
		box.right - box.left >= MIN_FIELD_SIZE &&
		box.bottom - box.top >= MIN_FIELD_SIZE &&
		inside(box, page)
	)
}

function clip(text: string): string {
	const clean = text.replace(/\s+/gu, " ").trim()

	return Array.from(clean).slice(0, FORM_FILL_LABEL_MAX_CHARS).join("").trim()
}

// A run's text as a label: what is left once the trailing colon, asterisk and dots go.
function runLabel(text: string): string {
	return clip(text.replace(/[\s:*._·…]+$/u, ""))
}

function overlap(a0: number, a1: number, b0: number, b1: number): number {
	return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))
}

// A field name's last part when it reads as words ("applicant.firstName" → "first Name"), never a code ("f1_01").
function nameLabel(name: string): string {
	const last = name.split(".").at(-1) ?? ""

	if (!/[\p{L}]{3,}/u.test(last)) return ""

	return clip(
		last
			.replace(/\[\d+\]$/u, "")
			.replace(/([\p{Ll}])([\p{Lu}])/gu, "$1 $2")
			.replace(/[_-]+/gu, " ")
	)
}

// What names each field: its tooltip (/TU), else the nearest page text to its left on the same line (overlapping at least
// half of the shorter height, within LABEL_LEFT_MAX), else directly above it (overlapping it sideways, within
// LABEL_ABOVE_MAX), else its name's last part when that reads as words. "" when nothing names it.
export function fieldLabels(fields: readonly FormFillCandidate[], runs: readonly TextRun[]): string[] {
	return fields.map(({ field, box }) => {
		const own = clip(field.label)

		if (own.length > 0) return own

		let left: { readonly gap: number; readonly label: string } | null = null
		let above: { readonly gap: number; readonly label: string } | null = null

		for (const run of runs) {
			const label = runLabel(run.text)

			if (label.length === 0) continue

			const shorter = Math.min(box.bottom - box.top, run.box.bottom - run.box.top)
			const leftGap = box.left - run.box.right

			if (
				leftGap >= -2 &&
				leftGap <= LABEL_LEFT_MAX &&
				shorter > 0 &&
				overlap(box.top, box.bottom, run.box.top, run.box.bottom) >= shorter / 2 &&
				(left === null || leftGap < left.gap)
			) {
				left = { gap: leftGap, label }
			}

			const aboveGap = box.top - run.box.bottom

			if (
				aboveGap >= -2 &&
				aboveGap <= LABEL_ABOVE_MAX &&
				overlap(box.left, box.right, run.box.left, run.box.right) > 0 &&
				(above === null || aboveGap < above.gap)
			) {
				above = { gap: aboveGap, label }
			}
		}

		return left?.label ?? above?.label ?? nameLabel(field.name)
	})
}

// The page's fields as the request takes them: eligible ones labelled, in tab order, at most FORM_FILL_MAX_FIELDS; the
// checkboxes and radio buttons, those past the limit and the unlabelled ones listed as left out. Ineligible fields
// (filled, read-only, password, tiny, off the page) are neither: the review never names them.
export function formFillPage(
	candidates: readonly FormFillCandidate[],
	page: Box,
	runs: readonly TextRun[],
	form: Pick<FormOverlaySession, "draft">
): FormFillPage {
	const ticks = candidates.filter(
		({ field, box }) =>
			(field.kind === "checkbox" || field.kind === "radio") &&
			!field.readOnly &&
			fieldEmpty(field) &&
			box.right - box.left >= MIN_FIELD_SIZE &&
			box.bottom - box.top >= MIN_FIELD_SIZE &&
			inside(box, page)
	)
	const eligible = candidates.filter(candidate => formFillEligible(candidate, page, form))
	const labels = fieldLabels([...eligible, ...ticks], runs)
	const offered: (FormFillCandidate & { readonly fill: FormFillField })[] = []
	const left: FormFillLeftOut[] = []

	eligible.forEach((candidate, index) => {
		const label = labels[index] ?? ""
		const { field } = candidate

		if (label.length === 0) {
			left.push({ field, reason: "unlabeled", label })
		} else if (offered.length >= FORM_FILL_MAX_FIELDS) {
			left.push({ field, reason: "limit", label })
		} else {
			offered.push({
				...candidate,
				fill: {
					id: field.id,
					kind: field.kind === "text" ? "text" : "choice",
					label,
					options: field.options,
					editable: field.editable,
					multiline: field.multiline,
					maxLength: field.maxLength
				}
			})
		}
	})

	ticks.forEach((candidate, index) => {
		left.push({ field: candidate.field, reason: "tick", label: labels[eligible.length + index] ?? "" })
	})

	return { offered, left }
}

// The setField value of a planned entry.
export function formFillValue(entry: FormFillEntry): PdfFieldValue {
	return entry.value.kind === "text" ? { kind: "text", text: entry.value.text } : { kind: "choice", values: entry.value.values }
}

export type FormFillApplied =
	| { readonly ok: true; readonly filled: number }
	// Fields filled or changed since the plan, of another kind now, or gone: nothing was filled.
	| { readonly ok: false; readonly reason: "changed"; readonly fields: readonly number[] }
	// The editor refused one (rolled back with every other of the gesture).
	| { readonly ok: false; readonly reason: "refused" }

let gestures = 0

// Accept on the editor (the change runs after every change before it, the drafts committed first): the page's widgets
// read again and every planned field checked still empty and of the same kind, then one forms.setField per field as one
// gesture (one op id, `final` on the last): one undo takes them all back, and a refused one rolls back the rest.
export async function applyFormFill(
	session: PdfEditSessionModel,
	page: number,
	entries: readonly FormFillEntry[]
): Promise<FormFillApplied> {
	const read = await session.engine.call("widgets", { pages: [page] })
	const now = new Map(engineFields(read.find(entry => entry.page === page)?.widgets ?? []).map(field => [field.id, field]))
	const changed = entries
		.filter(entry => {
			const field = now.get(entry.field.id)

			return (
				field === undefined ||
				!fieldEmpty(field) ||
				field.readOnly ||
				field.password ||
				(entry.field.kind === "text" ? field.kind !== "text" : field.kind !== "combo" && field.kind !== "list")
			)
		})
		.map(entry => entry.field.id)

	if (changed.length > 0) return { ok: false, reason: "changed", fields: changed }

	const id = `assistant-form-fill-${String(++gestures)}`

	try {
		for (const [index, entry] of entries.entries()) {
			await session.dispatch(
				"forms.setField",
				{ page, widget: entry.field.id, value: formFillValue(entry) },
				{ id, final: index === entries.length - 1 }
			)
		}
	} catch {
		return { ok: false, reason: "refused" }
	}

	return { ok: true, filled: entries.length }
}

// What the panel shows ghosted in the page's fields while it is open: the values it would fill, by widget.
export interface FormFillPreview {
	// 0-based.
	readonly page: number
	readonly values: ReadonlyMap<number, string>
}

export class FormFillPreviewStore {
	private value: FormFillPreview | null = null
	private readonly listeners = new Set<() => void>()

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)

		return () => {
			this.listeners.delete(listener)
		}
	}

	get = (): FormFillPreview | null => this.value

	set(value: FormFillPreview | null): void {
		if (value === this.value) return

		this.value = value

		for (const listener of this.listeners) listener()
	}
}

const previews = new WeakMap<object, FormFillPreviewStore>()

// The preview of the document `owner` stands for (the viewer's swap).
export function formFillPreview(owner: object): FormFillPreviewStore {
	let store = previews.get(owner)

	if (store === undefined) {
		store = new FormFillPreviewStore()
		previews.set(owner, store)
	}

	return store
}
