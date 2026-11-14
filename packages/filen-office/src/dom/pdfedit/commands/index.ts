import { FORM_COMMANDS, type PdfFormCommands } from "./forms"
import type { PdfCommand } from "./types"

// Every command the editor runs, one table per feature. A feature adds one import and one spread line here, and its
// argument map to PdfCommandArgs.

export type PdfCommandArgs = PdfFormCommands

export type PdfCommandName = keyof PdfCommandArgs

export const PDF_COMMANDS: { readonly [K in PdfCommandName]: PdfCommand<PdfCommandArgs[K]> } = {
	...FORM_COMMANDS
}

export function pdfCommand(name: string): PdfCommand<unknown> | undefined {
	return Object.hasOwn(PDF_COMMANDS, name) ? (PDF_COMMANDS[name as PdfCommandName] as PdfCommand<unknown>) : undefined
}

export { FORM_COMMANDS, type PdfFormCommands } from "./forms"
export { isIndex, isRecord, isText, type PdfCommand, type PdfCommandContext, type PdfCommandTable } from "./types"
