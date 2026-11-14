import { fieldEditable } from "../../../core/pdfedit/signaturePolicy"
import { PdfEngineRefusal } from "../context"
import { PdfFieldError, removeXfa, resetForm, setFieldValue, type PdfFieldValue } from "../fillSign"
import { isIndex, isRecord, isText, type PdfCommandTable } from "./types"

// Filling in a form through the Fill & Sign block (fillSign/fields.ts, which owns every rule): one field set to a
// value, the whole form reset, and a hybrid form's XFA data removed before its first save (the user confirmed). Each
// is one journal operation. Read-only fields, password fields (their value would be stored in the file) and fields a
// signature locks are refused. Scripts never run, so calculated fields do not update.

// The longest value a text field takes here (a field's own /MaxLen is applied on top).
const MAX_TEXT = 1_000_000
// A choice field's selected values: at most this many, each at most this long.
const MAX_CHOICES = 10_000
const MAX_CHOICE = 10_000

interface WidgetTarget {
	// 0-based page.
	readonly page: number
	// The widget annotation's object number (PdfWidgetSummary.id).
	readonly widget: number
}

export interface PdfFormCommands {
	"forms.setField": WidgetTarget & { readonly value: PdfFieldValue }
	"forms.reset": Record<string, never>
	"forms.removeXfa": Record<string, never>
}

function parseValue(value: unknown): PdfFieldValue | null {
	if (!isRecord(value)) return null

	switch (value["kind"]) {
		case "text":
			return isText(value["text"], MAX_TEXT) ? { kind: "text", text: value["text"] } : null
		case "checkbox":
			return typeof value["checked"] === "boolean" ? { kind: "checkbox", checked: value["checked"] } : null
		case "radio":
			return { kind: "radio" }
		case "choice": {
			const values = value["values"]

			return Array.isArray(values) && values.length <= MAX_CHOICES && values.every(item => isText(item, MAX_CHOICE))
				? { kind: "choice", values: values as string[] }
				: null
		}
		default:
			return null
	}
}

function parseField(args: unknown): PdfFormCommands["forms.setField"] | null {
	if (!isRecord(args) || !isIndex(args["page"]) || !isIndex(args["widget"])) return null

	const value = parseValue(args["value"])

	return value === null ? null : { page: args["page"], widget: args["widget"], value }
}

function parseNone(args: unknown): Record<string, never> | null {
	return isRecord(args) && Object.keys(args).length === 0 ? {} : null
}

function refusal(error: PdfFieldError): PdfEngineRefusal {
	return error.reason === "readOnly" || error.reason === "password"
		? new PdfEngineRefusal("notAllowed", `the field cannot be changed (${error.reason})`)
		: new PdfEngineRefusal("badRequest", `form field edit refused (${error.reason})`)
}

export const FORM_COMMANDS: PdfCommandTable<PdfFormCommands> = {
	"forms.setField": {
		tool: "formFill",
		target: "widget",
		parse: parseField,
		run: (context, args) => {
			if (args.page >= context.document.countPages()) throw new PdfEngineRefusal("badRequest", "no such page")

			const page = context.page(args.page)
			const widget = page.getWidgets().find(candidate => {
				const object = candidate.getObject()

				return object.isIndirect() && object.asIndirect() === args.widget
			})

			if (widget === undefined) throw new PdfEngineRefusal("badRequest", "no such widget")
			if (!fieldEditable(context.signatures, widget.getName()))
				throw new PdfEngineRefusal("notAllowed", "a signature locks the field")

			try {
				return setFieldValue(context.document, page, args.page, args.widget, args.value).sort((a, b) => a - b)
			} catch (error) {
				throw error instanceof PdfFieldError ? refusal(error) : error
			}
		}
	},
	"forms.reset": {
		tool: "formFill",
		parse: parseNone,
		run: context => resetForm(context.document)
	},
	// Nothing is drawn differently: the AcroForm fields already show the values. Offered with form filling, but it changes
	// the form itself, which no signer allowed: a signed document is rewritten, its signatures invalidated (asked first).
	"forms.removeXfa": {
		tool: "formFill",
		saves: "content",
		parse: parseNone,
		run: context => {
			removeXfa(context.document)

			return []
		}
	}
}
