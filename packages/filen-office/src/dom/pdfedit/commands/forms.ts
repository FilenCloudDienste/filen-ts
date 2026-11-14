import type * as Mupdf from "mupdf"
import { fieldEditable } from "../../../core/pdfedit/signaturePolicy"
import { PdfEngineRefusal } from "../context"
import { at, ref } from "../fields"
import { fieldNameOf, fieldPages } from "../formState"
import { isIndex, isRecord, isText, type PdfCommandContext, type PdfCommandTable } from "./types"

// Filling in a form: a text field's value, a choice, a checkbox or radio button turned on or off, the whole form
// reset. Each is one journal operation; the widget's appearance is regenerated so the page shows the value. Read-only
// fields and fields a signature locks are refused. Scripts never run, so calculated fields do not update.

// The longest value a text field takes here (a field's own /MaxLen is applied on top).
const MAX_TEXT = 1_000_000

const READ_ONLY = 1

interface WidgetTarget {
	// 0-based page.
	readonly page: number
	// The widget annotation's object number (PdfWidgetSummary.id).
	readonly widget: number
}

export interface PdfFormCommands {
	"forms.setText": WidgetTarget & { readonly value: string }
	"forms.setChoice": WidgetTarget & { readonly value: string }
	"forms.toggle": WidgetTarget
	"forms.reset": Record<string, never>
}

function parseTarget(args: unknown): WidgetTarget | null {
	return isRecord(args) && isIndex(args["page"]) && isIndex(args["widget"]) ? { page: args["page"], widget: args["widget"] } : null
}

function parseValue(args: unknown): (WidgetTarget & { readonly value: string }) | null {
	const target = parseTarget(args)

	return target !== null && isRecord(args) && isText(args["value"], MAX_TEXT) ? { ...target, value: args["value"] } : null
}

// The widget, refused unless its field may be changed now.
function editableWidget(context: PdfCommandContext, target: WidgetTarget, types: readonly string[]): Mupdf.PDFWidget {
	if (target.page >= context.document.countPages()) throw new PdfEngineRefusal("badRequest", "no such page")

	const widget = context
		.page(target.page)
		.getWidgets()
		.find(candidate => {
			const object = candidate.getObject()

			return object.isIndirect() && object.asIndirect() === target.widget
		})

	if (widget === undefined) throw new PdfEngineRefusal("badRequest", "no such widget")
	if (!types.includes(widget.getFieldType())) throw new PdfEngineRefusal("badRequest", "not a field of this type")
	if ((widget.getFieldFlags() & READ_ONLY) !== 0 || !fieldEditable(context.signatures, fieldNameOf(widget.getObject())))
		throw new PdfEngineRefusal("notAllowed", "the field cannot be changed")

	return widget
}

// Every page with a widget of the form (for a reset), from the field tree's widgets.
function formPages(context: PdfCommandContext): number[] {
	const pages = new Set<number>()
	const visit = (field: Mupdf.PDFObject, depth: number): void => {
		const page = ref(field, "P")

		if (page.isIndirect()) {
			const index = context.pageOf(page.asIndirect())

			if (index !== undefined) pages.add(index)
		}

		const kids = at(field, "Kids")

		if (depth < 32 && kids.isArray()) for (let index = 0; index < kids.length; index++) visit(at(kids, index), depth + 1)
	}
	const fields = at(context.document.getTrailer(), "Root", "AcroForm", "Fields")

	if (fields.isArray()) for (let index = 0; index < fields.length; index++) visit(at(fields, index), 0)

	return [...pages].sort((a, b) => a - b)
}

export const FORM_COMMANDS: PdfCommandTable<PdfFormCommands> = {
	"forms.setText": {
		tool: "formFill",
		parse: parseValue,
		run: (context, args) => {
			const widget = editableWidget(context, args, ["text", "combobox"])
			const max = widget.getFieldType() === "text" ? widget.getMaxLen() : 0
			// A field's /MaxLen counts characters, not UTF-16 units.
			const value = max > 0 ? Array.from(args.value).slice(0, max).join("") : args.value

			widget.setTextValue(value)
			widget.update()

			return [args.page]
		}
	},
	"forms.setChoice": {
		tool: "formFill",
		parse: parseValue,
		run: (context, args) => {
			const widget = editableWidget(context, args, ["combobox", "listbox"])
			const editable = widget.getFieldType() === "combobox" && (widget.getFieldFlags() & (1 << 18)) !== 0

			if (!editable && !widget.getOptions(false).includes(args.value) && !widget.getOptions(true).includes(args.value))
				throw new PdfEngineRefusal("badRequest", "not one of the field's options")

			widget.setChoiceValue(args.value)
			widget.update()

			return [args.page]
		}
	},
	"forms.toggle": {
		tool: "formFill",
		parse: parseTarget,
		run: (context, args) => {
			const widget = editableWidget(context, args, ["checkbox", "radiobutton"])

			widget.toggle()
			widget.update()

			// A radio group's other buttons turned off with it, on whatever page they are.
			return widget.getFieldType() === "radiobutton" ? fieldPages(widget.getObject(), context.pageOf, args.page) : [args.page]
		}
	},
	"forms.reset": {
		tool: "formFill",
		parse: args => (isRecord(args) && Object.keys(args).length === 0 ? {} : null),
		run: context => {
			const pages = formPages(context)

			context.document.resetForm(context.document.newArray(), true)

			for (const index of pages) context.page(index).update()

			return pages
		}
	}
}
