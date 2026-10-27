import { memorySink, type ByteSink, type OpcPackage, type Slicing } from "../../../core/opc/index"
import { writePptConversion } from "../../../core/ppt/toPptx"
import { PresentationError } from "../../../core/presentation/model"
import { packageSealer } from "../../encryption/seal"
import { passwordOfficeKey } from "../../encryption/webCrypto"
import type { ConvertCapability } from "../engine"
import type { ConversionReport, PortLike } from "../protocol"
import { SavePortAbortedError, savePortWriter, type SavePortEnd } from "../savePort"
import { pptLosses, pptPassword } from "./open/ppt"

// freshParts: a deck's state as a new package, streamed to the port (savePort.ts; the page reads it or an upload
// takes it). A PowerPoint 97–2003 deck is Save as .pptx: the package it was converted to, zipped part by part; one
// that opened with a password is sealed as Agile under that password, so the copy keeps it. Other conversions are not
// built yet: refused as notImplemented.

// Writes chunks of at most this many bytes to the port.
const CHUNK = 1024 * 1024

// A converted ppt package as .pptx bytes to `sink`; sealed as Agile under `password` when given (the zip is held in
// memory for it: the compound file needs the package's size first).
export async function pptSaveAs(pptx: OpcPackage, password: string | undefined, sink: ByteSink, slicing?: Slicing): Promise<number> {
	if (password === undefined) return (await writePptConversion(pptx, sink, slicing === undefined ? {} : { slicing })).size

	const memory = memorySink()

	await writePptConversion(pptx, memory, slicing === undefined ? {} : { slicing })

	const { sealer, release } = packageSealer(await passwordOfficeKey(password))
	let sealed: Uint8Array

	try {
		sealed = await sealer.seal(memory.bytes(), slicing === undefined ? {} : { slicing })
	} finally {
		release()
	}

	for (let at = 0; at < sealed.length; at += CHUNK) await sink.write(sealed.subarray(at, Math.min(sealed.length, at + CHUNK)))
	await sink.close()

	return sealed.length
}

export const convertCapability: ConvertCapability = {
	async freshParts(context, target, port: PortLike): Promise<ConversionReport> {
		// Only a ppt deck's Save as .pptx is built: anything else is refused before the port is touched.
		if (target !== "pptx") throw new PresentationError("notImplemented", "freshParts")

		const { session } = context
		const opc = session.package.opc

		if (session.deck.format !== "ppt" || opc === undefined) throw new PresentationError("notImplemented", "freshParts")

		const writer = savePortWriter(port as SavePortEnd)

		context.signal.onAbort(() => {
			writer.abort("cancelled")
		})
		writer.announce()

		try {
			const bytes = await pptSaveAs(opc, pptPassword(session.deck), writer, context.slicing)

			writer.commit()

			return { target: "pptx", bytes, losses: pptLosses(session.deck) ?? [] }
		} catch (error) {
			writer.abort(error instanceof SavePortAbortedError ? "cancelled" : "failed")

			throw error
		}
	}
}
