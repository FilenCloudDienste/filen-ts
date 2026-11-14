import { ANNOTATION_COMMANDS, type PdfAnnotationCommands } from "./annotations"
import { CROP_COMMANDS, type PdfCropCommands } from "./crop"
import { FILL_SIGN_COMMANDS, type PdfFillSignCommands } from "./fillSign"
import { FORM_COMMANDS, type PdfFormCommands } from "./forms"
import { OCR_COMMANDS, type PdfOcrCommands } from "./ocr"
import { PAGE_COMMANDS, type PdfPageCommands } from "./pages"
import { REDACT_COMMANDS, type PdfRedactCommands } from "./redact"
import { SIGN_COMMANDS, type PdfSignCommands } from "./sign"
import { TEXT_EDIT_COMMANDS, type PdfTextEditCommands } from "./textEdit"
import type { PdfCommand } from "./types"

// Every command the editor runs, one table per feature. A feature adds one import and one spread line here, and its
// argument map to PdfCommandArgs.

export type PdfCommandArgs = PdfFormCommands &
	PdfFillSignCommands &
	PdfAnnotationCommands &
	PdfPageCommands &
	PdfCropCommands &
	PdfRedactCommands &
	PdfTextEditCommands &
	PdfOcrCommands &
	PdfSignCommands

export type PdfCommandName = keyof PdfCommandArgs

export const PDF_COMMANDS: { readonly [K in PdfCommandName]: PdfCommand<PdfCommandArgs[K]> } = {
	...FORM_COMMANDS,
	...FILL_SIGN_COMMANDS,
	...ANNOTATION_COMMANDS,
	...PAGE_COMMANDS,
	...CROP_COMMANDS,
	...REDACT_COMMANDS,
	...TEXT_EDIT_COMMANDS,
	...OCR_COMMANDS,
	...SIGN_COMMANDS
}

export function pdfCommand(name: string): PdfCommand<unknown> | undefined {
	return Object.hasOwn(PDF_COMMANDS, name) ? (PDF_COMMANDS[name as PdfCommandName] as PdfCommand<unknown>) : undefined
}

export { ANNOTATION_COMMANDS, PDF_STAMP_MAX_BYTES, type PdfAnnotationCommands } from "./annotations"
export { CROP_COMMANDS, type PdfCropCommands } from "./crop"
export { FILL_SIGN_COMMANDS, type PdfFillPlacement, type PdfFillSignCommands } from "./fillSign"
export { FORM_COMMANDS, type PdfFormCommands } from "./forms"
export { OCR_COMMANDS, ocrGraft, type PdfOcrCommands } from "./ocr"
export { changedPages, PAGE_COMMANDS, type PdfPageCommands } from "./pages"
export { REDACT_COMMANDS, redactionManifest, type PdfRedactCommands, type PdfRedactFinding } from "./redact"
export { pendingSignature, SIGN_COMMANDS, type PdfSignCommands, type PdfSignFieldArgs, type PendingSignature } from "./sign"
export { TEXT_EDIT_COMMANDS, TEXT_EDIT_UNSAFE, type PdfTextEditCommands } from "./textEdit"
export {
	isIndex,
	isRecord,
	isText,
	outcomePages,
	type PdfCommand,
	type PdfCommandOutcome,
	type PdfCommandContext,
	type PdfCommandTable
} from "./types"
