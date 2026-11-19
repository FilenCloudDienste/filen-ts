import type { DocDecryption } from "../../doc/decrypt"
import type { ProtectionKeyHash } from "../../doc/toDocx/index"
import type { RtfTurns } from "../../rtf/turns"
import { TextConversionError, type TextConversion, type TextSourceFormat, type TextTargetFormat } from "./report"
import { docToDocx, odtToDocx, odtTranslationToDocx, rtfToDocx } from "./toDocx"
import { docxToOdt } from "./toOdt"

export type {
	DocxToOdtLossyKind,
	RtfLossyKind,
	TextConversion,
	TextConversionRefusal,
	TextLossyFeature,
	TextLossyKind,
	TextLossyReport,
	TextRefusalReason,
	TextSourceFormat,
	TextTargetFormat
} from "./report"
export { withoutOrigins } from "./toDocx"

// Text document conversions, bytes in and bytes out, with what the target could not hold counted by kind:
// .docx → .odt, and .odt, .rtf, .doc → .docx. Nothing is dropped silently: each approximation or omission is in the
// report, and a file that cannot be converted is refused with a reason. Run where the document engine runs (a worker):
// a whole document is read and written.

export interface TextConvertOptions {
	// Cancellation and slices: an aborted job resolves as refused "aborted".
	readonly turns?: RtfTurns
	// The password of an encrypted .doc ([MS-DOC] §2.2.6): without it the file is refused "encrypted".
	readonly decryption?: DocDecryption
	// Hashes a .doc's editing-restriction key into the package (convertDocToDocx); without it the restriction is
	// kept without its password, reported "passwordProtection".
	readonly protectionKey?: (verifier: number) => Promise<ProtectionKeyHash>
}

const CONVERSIONS: ReadonlySet<string> = new Set(["docx>odt", "odt>docx", "rtf>docx", "doc>docx"])

export function canConvertText(from: TextSourceFormat, to: TextTargetFormat): boolean {
	return CONVERSIONS.has(`${from}>${to}`)
}

export async function convertText(
	source: Uint8Array,
	from: TextSourceFormat,
	to: TextTargetFormat,
	options: TextConvertOptions = {}
): Promise<TextConversion> {
	if (!canConvertText(from, to)) return { ok: false, refusal: { reason: "unsupported", message: `no conversion from ${from} to ${to}` } }

	try {
		const result =
			from === "docx"
				? await docxToOdt(source, options)
				: await (from === "odt" ? odtToDocx : from === "rtf" ? rtfToDocx : docToDocx)(source, options)

		if (options.turns?.signal.aborted === true) throw new TextConversionError("aborted", "aborted")

		return { ok: true, bytes: result.bytes, lossy: result.lossy.report(from, to) }
	} catch (error) {
		if (error instanceof TextConversionError) return { ok: false, refusal: error.refusal }

		return {
			ok: false,
			refusal: { reason: "corrupt", message: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }
		}
	}
}

// The document editor's edited copy of an OpenDocument text (the WordprocessingML package the ODT translator made,
// with the parts the docx writer wrote) as a standalone .docx: unsaved edits downloaded as .docx. A .docx, .rtf or
// .doc source's edited package is a .docx already (convertText(edited, "docx", "odt") for .odt).
export async function convertOdtEditToDocx(edited: Uint8Array, options: Pick<TextConvertOptions, "turns"> = {}): Promise<TextConversion> {
	try {
		const result = await odtTranslationToDocx(edited, options)

		if (options.turns?.signal.aborted === true) throw new TextConversionError("aborted", "aborted")

		return { ok: true, bytes: result.bytes, lossy: result.lossy.report("odt", "docx") }
	} catch (error) {
		if (error instanceof TextConversionError) return { ok: false, refusal: { reason: error.reason, message: error.message } }

		return {
			ok: false,
			refusal: { reason: "corrupt", message: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }
		}
	}
}
