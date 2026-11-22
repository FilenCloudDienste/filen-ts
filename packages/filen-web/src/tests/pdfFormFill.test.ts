import { describe, expect, it, vi } from "vitest"
import type { FormFillEntry } from "@filen/shared/assistant"
import type { PdfWidgetSummary } from "@filen/office/core/pdfedit"
import type { PdfEditSessionModel } from "@filen/office/react/pdfedit"
import {
	applyFormFill,
	fieldLabels,
	formFillEligible,
	formFillPage,
	type Box,
	type FormFillCandidate
} from "@/features/pdf/forms/formFill.logic"
import type { OverlayField } from "@/features/pdf/session/fieldOverlay.logic"

// The assistant's form fill on a page: which fields are offered (never a hidden, tiny, off-page, read-only, password,
// filled or drafted one), what names each, and Accept as one gesture of the editor.

const PAGE: Box = { left: 0, top: 0, right: 600, bottom: 800 }

function field(id: number, extra: Partial<OverlayField> = {}): OverlayField {
	return {
		id,
		kind: "text",
		name: `form.f${String(id)}`,
		rect: [0, 0, 100, 20],
		value: "",
		selected: [],
		onState: null,
		options: [],
		label: "",
		readOnly: false,
		required: false,
		password: false,
		multiline: false,
		comb: false,
		maxLength: 0,
		multiSelect: false,
		editable: false,
		...extra
	}
}

function at(left: number, top: number, width = 150, height = 18): Box {
	return { left, top, right: left + width, bottom: top + height }
}

const NO_DRAFTS = { draft: () => undefined }

describe("which fields the form fill offers", () => {
	it("offers empty text fields and choices of a visible size on the page only", () => {
		const offered = (candidate: FormFillCandidate, drafts: { draft: (id: number) => unknown } = NO_DRAFTS) =>
			formFillEligible(candidate, PAGE, drafts as never)

		expect(offered({ field: field(1), box: at(100, 100) })).toBe(true)
		expect(offered({ field: field(2, { kind: "combo" }), box: at(100, 100) })).toBe(true)
		expect(offered({ field: field(3, { kind: "checkbox" }), box: at(100, 100) })).toBe(false)
		expect(offered({ field: field(4, { readOnly: true }), box: at(100, 100) })).toBe(false)
		expect(offered({ field: field(5, { password: true }), box: at(100, 100) })).toBe(false)
		expect(offered({ field: field(6, { value: "Jane" }), box: at(100, 100) })).toBe(false)
		expect(offered({ field: field(7), box: at(100, 100, 2, 18) })).toBe(false)
		expect(offered({ field: field(8), box: at(100, 100, 150, 1) })).toBe(false)
		expect(offered({ field: field(9), box: at(590, 100) })).toBe(false)
		expect(offered({ field: field(10), box: at(100, -40) })).toBe(false)
		expect(offered({ field: field(11), box: at(100, 100) }, { draft: id => (id === 11 ? { page: 0, text: "x" } : undefined) })).toBe(
			false
		)
	})
})

describe("field labels", () => {
	const runs = [
		{ text: "Full name:", box: at(20, 100, 70, 14) },
		{ text: "Date of birth", box: at(300, 150, 120, 12) },
		{ text: "Far away label", box: at(20, 300, 40, 14) },
		{ text: "Notes", box: at(20, 400, 40, 12) }
	]

	it("takes the tooltip, else the text to the left on the line, else just above, else a worded name", () => {
		const labels = fieldLabels(
			[
				{ field: field(1, { label: "Applicant's name" }), box: at(100, 98) },
				{ field: field(2), box: at(100, 98) },
				{ field: field(3), box: at(300, 165) },
				{ field: field(4), box: at(400, 300) },
				{ field: field(5, { name: "applicant.homeAddress" }), box: at(100, 600) },
				{ field: field(6, { name: "topmostSubform[0].f1_01[0]" }), box: at(100, 650) },
				{ field: field(7), box: at(20, 415, 200, 60) }
			],
			runs
		)

		expect(labels).toEqual(["Applicant's name", "Full name", "Date of birth", "", "home Address", "", "Notes"])
	})

	it("cuts a label at 48 characters", () => {
		expect(fieldLabels([{ field: field(1, { label: "x".repeat(80) }), box: at(0, 0) }], [])[0]).toHaveLength(48)
	})
})

describe("a form fill page", () => {
	it("lists checkboxes, unnamed fields and those past the limit as left out", () => {
		const candidates: FormFillCandidate[] = [
			{ field: field(1, { label: "Name" }), box: at(100, 100) },
			{ field: field(2), box: at(100, 140) },
			{ field: field(3, { kind: "checkbox", label: "I agree" }), box: at(100, 180, 12, 12) },
			{ field: field(4, { kind: "list", label: "Colour", options: [{ value: "r", label: "Red" }] }), box: at(100, 220) },
			...Array.from({ length: 41 }, (_, index) => ({
				field: field(100 + index, { label: `Row ${String(index)}` }),
				box: at(100, 260 + index * 10, 100, 8)
			}))
		]
		const page = formFillPage(candidates, PAGE, [], NO_DRAFTS)

		expect(page.offered).toHaveLength(40)
		expect(page.offered.slice(0, 2).map(entry => entry.fill)).toEqual([
			{ id: 1, kind: "text", label: "Name", options: [], editable: false, multiline: false, maxLength: 0 },
			{
				id: 4,
				kind: "choice",
				label: "Colour",
				options: [{ value: "r", label: "Red" }],
				editable: false,
				multiline: false,
				maxLength: 0
			}
		])
		expect(page.left.map(left => [left.field.id, left.reason])).toEqual([
			[2, "unlabeled"],
			[138, "limit"],
			[139, "limit"],
			[140, "limit"],
			[3, "tick"]
		])
	})
})

describe("accepting a form fill", () => {
	function entry(id: number, text: string): FormFillEntry {
		return {
			field: { id, kind: "text", label: `F${String(id)}`, options: [], editable: false, multiline: false, maxLength: 0 },
			value: { kind: "text", text },
			shown: text
		}
	}

	function widget(id: number, value = ""): PdfWidgetSummary {
		return {
			id,
			page: 2,
			rect: [0, 0, 100, 20],
			type: "text",
			field: `f${String(id)}`,
			label: "",
			value,
			selected: [],
			onState: null,
			options: [],
			maxLength: 0,
			readOnly: false,
			required: false,
			multiline: false,
			password: false,
			comb: false,
			multiSelect: false,
			editable: false,
			hidden: false,
			locked: false
		}
	}

	function session(widgets: readonly PdfWidgetSummary[], refuse?: number) {
		const dispatch = vi.fn((_command: string, args: { widget: number }) =>
			args.widget === refuse ? Promise.reject(new Error("refused")) : Promise.resolve({})
		)

		return {
			dispatch,
			model: { engine: { call: () => Promise.resolve([{ page: 2, widgets }]) }, dispatch } as unknown as PdfEditSessionModel
		}
	}

	it("sets every field as one gesture, final only on the last", async () => {
		const s = session([widget(7), widget(8), widget(9)])

		await expect(applyFormFill(s.model, 2, [entry(7, "Jane"), entry(8, "Doe"), entry(9, "Berlin")])).resolves.toEqual({
			ok: true,
			filled: 3
		})

		const ops = s.dispatch.mock.calls.map(call => (call as unknown[])[2] as { id: string; final: boolean })

		expect(s.dispatch.mock.calls.map(call => (call as unknown[])[1])).toEqual([
			{ page: 2, widget: 7, value: { kind: "text", text: "Jane" } },
			{ page: 2, widget: 8, value: { kind: "text", text: "Doe" } },
			{ page: 2, widget: 9, value: { kind: "text", text: "Berlin" } }
		])
		expect(new Set(ops.map(op => op.id)).size).toBe(1)
		expect(ops.map(op => op.final)).toEqual([false, false, true])
	})

	it("fills nothing when a field was filled or hidden meanwhile", async () => {
		const s = session([widget(7), widget(8, "typed"), { ...widget(9), hidden: true }])

		await expect(applyFormFill(s.model, 2, [entry(7, "Jane"), entry(8, "Doe"), entry(9, "Berlin")])).resolves.toEqual({
			ok: false,
			reason: "changed",
			fields: [8, 9]
		})
		expect(s.dispatch).not.toHaveBeenCalled()
	})

	it("stops at a refused field (the editor rolls the gesture back)", async () => {
		const s = session([widget(7), widget(8), widget(9)], 8)

		await expect(applyFormFill(s.model, 2, [entry(7, "Jane"), entry(8, "Doe"), entry(9, "Berlin")])).resolves.toEqual({
			ok: false,
			reason: "refused"
		})
		expect(s.dispatch).toHaveBeenCalledTimes(2)
	})
})
