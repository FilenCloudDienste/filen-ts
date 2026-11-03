import {
	canConvertText,
	convertText,
	type TextConversion,
	type TextLossyFeature,
	type TextRefusalReason,
	type TextSourceFormat,
	type TextTargetFormat
} from "../../core/convert/text/index"
import type { Slicing } from "../../core/slicing"
import type { DocEncryptionScheme } from "../../core/doc/errors"
import { PackageSealError, packageSealer } from "../encryption/seal"
import { decryptionOf } from "../encryption/legacyDecryption"
import { passwordOfficeKey, releaseOfficeKey } from "../encryption/webCrypto"
import { macrotaskYield } from "./host"
import type { DocxAbortSignal } from "./protection"

// Text documents converted where the document engine runs (web: the docx worker), never on the page's thread: the
// file goes there as a copy, is converted in slices and comes back as the converted file with what it could not
// keep. A conversion the converter has no direct path for goes through .docx (RTF or Word 97–2003 to .odt), its two
// reports joined. Closing the job ends it at its next slice. A Word 97–2003 document's password to open goes with its
// one request: the .docx it converts to is sealed as an Agile-encrypted package under the same password (the
// password is not kept); it never becomes an .odt, for which no encryption is written.

export type { TextLossyFeature, TextRefusalReason, TextSourceFormat, TextTargetFormat }

export type DocxConversion =
	| { readonly kind: "converted"; readonly bytes: Uint8Array; readonly lossy: readonly TextLossyFeature[] }
	// encryption: an encrypted Word 97–2003 document's cipher ("unknown": none a password opens here).
	| {
			readonly kind: "refused"
			readonly reason: TextRefusalReason
			readonly message: string
			readonly encryption?: DocEncryptionScheme
	  }
	| { readonly kind: "aborted" }

export interface DocxConverter {
	// `bytes` is copied (the caller's buffer stays its own) unless `owned`: a buffer nothing else holds, handed over as is.
	convert(
		bytes: Uint8Array,
		from: TextSourceFormat,
		to: TextTargetFormat,
		options?: { readonly signal?: DocxAbortSignal; readonly owned?: boolean; readonly password?: string }
	): Promise<DocxConversion>
}

// The steps from `from` to `to`: direct, else through .docx; empty when there is no way.
export function conversionSteps(from: TextSourceFormat, to: TextTargetFormat): readonly (readonly [TextSourceFormat, TextTargetFormat])[] {
	if (canConvertText(from, to)) return [[from, to]]

	if (to === "odt" && canConvertText(from, "docx") && canConvertText("docx", "odt")) {
		return [
			[from, "docx"],
			["docx", "odt"]
		]
	}

	return []
}

// One entry per kind, counts added, in first-seen order.
function joined(reports: readonly (readonly TextLossyFeature[])[]): TextLossyFeature[] {
	const counts = new Map<TextLossyFeature["kind"], number>()

	for (const report of reports) for (const { kind, count } of report) counts.set(kind, (counts.get(kind) ?? 0) + count)

	return [...counts].map(([kind, count]) => ({ kind, count }))
}

// `docx` sealed under a new Agile key for `password` (container.ts's compound file), checked by reading it back.
async function sealed(docx: Uint8Array, password: string, signal: { readonly aborted: boolean }, slicing: Slicing): Promise<Uint8Array> {
	const key = await passwordOfficeKey(password)
	const { sealer, release } = packageSealer(key)

	try {
		return await sealer.seal(docx, { signal, slicing })
	} finally {
		release()
		releaseOfficeKey(key)
	}
}

export interface DocxConvertServer {
	convert(id: number, bytes: Uint8Array, from: TextSourceFormat, to: TextTargetFormat, password?: string): Promise<TextConversion>
	// Ends a running job at its next slice; false when `id` is not one.
	close(id: number): boolean
}

let realmSlicing: Slicing | undefined

// `slicing`: how a job gives the thread back (default a macrotask turn every 12 ms).
export function docxConvertServer(slicing?: Slicing): DocxConvertServer {
	const running = new Map<number, { aborted: boolean }>()
	const slices = slicing ?? (realmSlicing ??= { pause: macrotaskYield(), sliceMs: 12, now: () => Date.now() })

	return {
		async convert(id, bytes, from, to, password) {
			const signal = { aborted: false }
			const steps = conversionSteps(from, to)

			running.set(id, signal)

			try {
				if (steps.length === 0) {
					return { ok: false, refusal: { reason: "unsupported", message: `No conversion from ${from} to ${to}` } }
				}

				if (password !== undefined && (from !== "doc" || to !== "docx")) {
					return {
						ok: false,
						refusal: { reason: "encrypted", message: `A protected file is not converted from ${from} to ${to}` }
					}
				}

				const reports: (readonly TextLossyFeature[])[] = []
				let current = bytes

				for (const [stepFrom, stepTo] of steps) {
					const step = await convertText(current, stepFrom, stepTo, {
						turns: { signal, slicing: slices },
						...(password === undefined ? {} : { decryption: decryptionOf(password) })
					})

					if (!step.ok) return step

					reports.push(step.lossy.features)
					current = step.bytes
				}

				return {
					ok: true,
					bytes: password === undefined ? current : await sealed(current, password, signal, slices),
					lossy: { from, to, features: joined(reports) }
				}
			} catch (error) {
				if (error instanceof PackageSealError) {
					return {
						ok: false,
						refusal: { reason: error.reason === "check" ? "corrupt" : "aborted", message: error.message }
					}
				}

				throw error
			} finally {
				running.delete(id)
			}
		},
		close(id) {
			const signal = running.get(id)

			if (signal === undefined) return false

			signal.aborted = true
			running.delete(id)

			return true
		}
	}
}

export function answerOf(result: TextConversion): DocxConversion {
	if (result.ok) return { kind: "converted", bytes: result.bytes, lossy: result.lossy.features }

	return result.refusal.reason === "aborted"
		? { kind: "aborted" }
		: {
				kind: "refused",
				reason: result.refusal.reason,
				message: result.refusal.message,
				...(result.refusal.encryption === undefined ? {} : { encryption: result.refusal.encryption })
			}
}
