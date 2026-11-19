import { mayHoldControls, mayHoldFields } from "../edit/invariants/forms"
import { docxSchema } from "../edit/schema"
import type { PagedEditor } from "../paged/editor"
import type { ObjectHit, ObjectHitProvider } from "../paged/objects"
import { inlineControlAround, legacyFieldOf, type ControlInfo } from "./controls"

// Content controls under a page point: a press on a checkbox's glyph toggles it (control.check), on a list or
// date control opens its picker (control.choose, control.date); the same for legacy form fields. `part` names
// which: "checkbox", "list" or "date". Only the press's own text is looked at.

function partOf(info: ControlInfo): string | undefined {
	if (info.checkbox !== null) return "checkbox"
	if (info.type === "dropDownList" || info.type === "comboBox") return "list"
	if (info.date !== null) return "date"

	return undefined
}

function inside(editor: PagedEditor, from: number, to: number, page: number, x: number, y: number): ObjectHit["box"] | undefined {
	for (const rect of editor.rangeRects(from, to, page)) {
		if (x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height)
			return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
	}

	return undefined
}

const CONTROLS: ObjectHitProvider = {
	kind: "control",
	hit(editor, page, x, y) {
		const session = editor.session
		const part = session.story.part

		if (!mayHoldControls(session) && !mayHoldFields(session)) return undefined

		const hit = editor.hitTest(page, x, y)

		if (hit === undefined) return undefined

		const doc = session.state.doc
		const pos = Math.max(0, Math.min(hit.pos, doc.content.size))
		const around = mayHoldControls(session) ? inlineControlAround(part, doc, pos, pos) : undefined
		const name = around === undefined ? undefined : partOf(around.info)

		if (around !== undefined && name !== undefined) {
			const box = inside(editor, around.from, around.to, page, x, y)

			if (box !== undefined) return { kind: "control", story: editor.activeStory, pos: around.from, box, part: name }
		}

		const $pos = doc.resolve(pos)

		for (const [node, at] of [
			[$pos.nodeAfter, pos],
			[$pos.nodeBefore, pos - ($pos.nodeBefore?.nodeSize ?? 0)]
		] as const) {
			if (node === null || node.type !== docxSchema.nodes.field) continue

			const field = legacyFieldOf(part, node)

			if (field === undefined || field.type === "FORMTEXT") continue

			const box = inside(editor, at, at + node.nodeSize, page, x, y)

			if (box !== undefined)
				return {
					kind: "control",
					story: editor.activeStory,
					pos: at,
					box,
					part: field.type === "FORMCHECKBOX" ? "checkbox" : "list"
				}
		}

		return undefined
	}
}

export const FORM_HITS: readonly ObjectHitProvider[] = [CONTROLS]
