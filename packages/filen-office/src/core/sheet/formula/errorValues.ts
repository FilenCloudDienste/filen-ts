import { CellError, ErrorType, HyperFormula } from "hyperformula"
import { GENERIC_ERRORS } from "./functions/plugin"

// A cell holding one of Excel's errors the engine has no type for (#NULL!, #CALC!, #GETTING_DATA and the others of
// GENERIC_ERRORS, as a file stores a formula's cached result) is that error, not text: ISERROR is TRUE for it and
// IFERROR catches it. The engine reads only its own error texts so; here it reads these as its generic error with the
// text as message, which the engine and functions/plugin.ts give out as the text again.

type Parse = (this: unknown, content: unknown) => unknown
type ErrorContent = new (type: ErrorType, message?: string) => unknown

let installed = false

export function installErrorValues(licenseKey: string): void {
	if (installed) return

	installed = true

	const probe = HyperFormula.buildEmpty({ licenseKey })

	try {
		const parser = (probe as unknown as { readonly _cellContentParser: { parse: Parse } })._cellContentParser
		const prototype = Object.getPrototypeOf(parser) as { parse: Parse }
		const parse = prototype.parse
		const sample = parse.call(parser, "#DIV/0!") as { readonly value?: unknown } | null
		const Content = (sample as object | null)?.constructor as ErrorContent | undefined

		if (Content === undefined || !(sample?.value instanceof CellError)) return

		prototype.parse = function (content) {
			if (typeof content === "string" && content.charCodeAt(0) === 35 && content.length <= 16) {
				const text = content.toUpperCase()

				if (GENERIC_ERRORS.has(text)) return new Content(ErrorType.ERROR, text)
			}

			return parse.call(this, content)
		}
	} finally {
		probe.destroy()
	}
}
