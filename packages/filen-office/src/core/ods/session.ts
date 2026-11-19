import type { ByteSource } from "../opc/io"
import type { InflateHook } from "../opc/zipReader"
import { sheetOpenFailure, XlsxReadError } from "../xlsx/read/index"
import { XlsxDocument } from "../xlsx/edit/document"
import { XLSX_FEATURES, type XlsxSessionOpen } from "../sheet/commands"
import type { SheetEvent, SheetSessionOptions } from "../sheet/protocol"
import { sheetRegistry, type SheetFeature } from "../sheet/registry"
import { RenderStyleTable, SheetSession, sessionFeature } from "../sheet/session"
import { openOds } from "./open"
import { odsWriter } from "./write/writer"

// An OpenDocument spreadsheet as a session of the xlsx document: every sheet read at open (content.xml is one
// stream), editable and saved through odsWriter. An encrypted package is refused as core/odf refuses it.
export type OdsSessionOpen = XlsxSessionOpen | { readonly kind: "refused"; readonly reason: "unsupported" }

export async function openOdsSession(
	source: ByteSource,
	options: SheetSessionOptions,
	onEvent: (event: SheetEvent) => void,
	features: readonly SheetFeature<XlsxDocument>[] = [],
	inflate?: InflateHook
): Promise<OdsSessionOpen> {
	const opened = await openOds(source, {
		...(options.slicing !== undefined && { slicing: options.slicing }),
		...(options.signal !== undefined && { signal: options.signal }),
		...(inflate !== undefined && { inflate })
	})

	if (!opened.ok) {
		if (opened.reason === "aborted") return { kind: "aborted" }
		if (opened.reason === "encrypted") return { kind: "refused", reason: "unsupported" }

		return { kind: "failed", reason: sheetOpenFailure(opened.reason), message: opened.message }
	}

	const styles = new RenderStyleTable()
	const document = new XlsxDocument(opened.workbook, styles, {
		kind: options.kind,
		...(options.settings !== undefined && { settings: options.settings }),
		writer: odsWriter(opened.workbook, inflate)
	})
	const session = new SheetSession(
		document,
		styles,
		{ features: own => sheetRegistry([...XLSX_FEATURES, ...features, sessionFeature(own)]) },
		options,
		onEvent
	)

	try {
		const info = await session.start(options.signal)

		return { kind: "opened", session, info }
	} catch (error) {
		session.close()

		if (error instanceof XlsxReadError) {
			if (error.code === "aborted") return { kind: "aborted" }

			return { kind: "failed", reason: error.code === "tooLarge" ? "tooLarge" : "malformed", message: error.message }
		}

		throw error
	}
}
