import { defineSheetFeature } from "../../sheet/registry"
import type { Slicing } from "../../slicing"
import { isLegacyKind, type XlsxDocument } from "../../xlsx/edit/document"
import { saveXlsx } from "../../xlsx/write/save"
import type { ByteSource } from "../../opc/io"
import { odsSource } from "../source"
import { convertSheet } from "./convert"
import type { SheetLossyFeature } from "./report"
import type { SheetConversion, SheetConversionFormat } from "./types"

// Save as .ods or .xlsx of an open workbook: the workbook as the session holds it now (unsaved edits too), written
// by its own writer to memory, nothing committed, then converted. Its own family is that write as it is.

declare module "../../sheet/protocol" {
	interface SheetQueryMap {
		"saveAs.format": {
			// language: the user's (BCP 47), which an .ods written takes as its default (SheetConvertOptions.language).
			request: { readonly format: SheetConversionFormat; readonly language?: string }
			result: SheetConversion
		}
	}
}

// Slices where the host gives none (a worker): a task's turn ends after this long, so an abort sent meanwhile is
// read.
const WORKER_SLICING: Slicing = {
	sliceMs: 50,
	now: () => Date.now(),
	pause: () => {
		const timer: unknown = Reflect.get(globalThis, "setTimeout")

		return new Promise(resolve => {
			if (typeof timer === "function") (timer as (callback: () => void, ms: number) => void)(resolve, 0)
			else resolve()
		})
	}
}

const VALUES_ONLY: SheetLossyFeature = { kind: "valuesOnly", count: 1, sheets: [] }

// The bytes of a package as it was read.
async function sourceBytes(source: ByteSource): Promise<Uint8Array> {
	return source.read(0, source.size)
}

async function ownBytes(
	document: XlsxDocument,
	slicing: Slicing
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; message: string }> {
	const workbook = document.workbook
	// Unedited: the package as read (a save would copy it entry by entry and read the copy back).
	const untouched = workbook.changes.empty

	if (workbook.format === "ods") {
		const source = odsSource(workbook)

		if (untouched && source !== undefined) return { ok: true, bytes: await sourceBytes(source.odf.archive.source) }

		const saved = await document.save({ slicing, untouched })

		return saved.ok ? { ok: true, bytes: saved.bytes } : { ok: false, message: saved.message }
	}

	// The package as written, not sealed: what is converted is the plaintext either way.
	if (untouched) return { ok: true, bytes: await sourceBytes(workbook.opc.zip.source) }

	const saved = await saveXlsx({ opc: workbook.opc, workbook }, { slicing })

	if (!saved.ok) return { ok: false, message: `${saved.reason}: ${saved.message}` }

	return saved.bytes === undefined ? { ok: false, message: "The save wrote no bytes" } : { ok: true, bytes: saved.bytes }
}

export const saveAsFormatFeature = defineSheetFeature<XlsxDocument>({
	id: "saveAs.format",
	queries: {
		"saveAs.format": {
			run: async (context, request): Promise<SheetConversion> => {
				const document = context.doc
				const slicing = context.slicing ?? WORKER_SLICING
				const signal = context.signal ?? { aborted: false }
				const own = await ownBytes(document, slicing)

				if (signal.aborted) return { ok: false, reason: "aborted", message: "The conversion was aborted" }
				if (!own.ok) return { ok: false, reason: "unsupported", message: own.message }

				const family = document.workbook.format === "ods" ? "ods" : "xlsx"
				// A legacy workbook's session holds its values alone: the copy says what that left out.
				const read: readonly SheetLossyFeature[] = isLegacyKind(document.kind) ? [VALUES_ONLY] : []

				if (request.format === family) return { ok: true, bytes: own.bytes, lossy: read }

				const converted = await convertSheet(own.bytes, family, request.format, {
					turns: { signal, slicing },
					...(request.language !== undefined && { language: request.language }),
					...(context.settings.chartText !== undefined && { chartText: context.settings.chartText })
				})

				return converted.ok && read.length > 0 ? { ...converted, lossy: [...read, ...converted.lossy] } : converted
			}
		}
	}
})
