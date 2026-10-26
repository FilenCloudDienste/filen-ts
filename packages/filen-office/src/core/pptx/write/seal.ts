import { isSealedOfficeFile } from "../../encryption/index"
import { memorySink, type ByteSink, type Slicing } from "../../opc/index"
import { refused, type Deck, type Refused } from "../../presentation/model"
import { savePptx } from "./save"
import type { FreshPptx, PptxSaveInput, PptxSaveOptions, PptxSaveOutcome, PptxSource } from "./types"

// Saving an encrypted deck ([MS-OFFCRYPTO] §2.3.4.10–§2.3.4.15): the package cannot stream (the compound file needs
// the EncryptedPackage size up front), so it is zipped into memory, proved there (gate 2 of save.ts runs on the
// in-memory path), then sealed as Agile under the session's key by the realm that holds it, and the sealed compound
// file goes to the sink. A Standard source is sealed as Agile. Peak memory: the zip plus the sealed file, about 2.1×
// the package.

// What seals a zip: the session's PackageSealer (dom/encryption), which seals and reads the result back before it
// returns it. Structural, so the core never imports the realm that holds the key.
export interface PptxSealer {
	seal(zip: Uint8Array, options?: { readonly slicing?: Slicing }): Promise<Uint8Array>
	readonly released: boolean
}

const CHUNK = 1024 * 1024

async function sealInto(zip: Uint8Array, sealer: PptxSealer, sink: ByteSink, slicing: Slicing | undefined): Promise<Refused | undefined> {
	if (sealer.released) return refused("closed", "The deck's key was released")

	let sealed: Uint8Array

	try {
		sealed = await sealer.seal(zip, slicing === undefined ? {} : { slicing })
	} catch (error) {
		return refused("failed", `Sealing failed: ${error instanceof Error ? error.message : String(error)}`)
	}

	if (!isSealedOfficeFile(sealed)) return refused("failed", "The sealed save is not a compound file")

	for (let at = 0; at < sealed.length; at += CHUNK) await sink.write(sealed.subarray(at, Math.min(sealed.length, at + CHUNK)))
	await sink.close()

	return undefined
}

// The save of an encrypted deck: unchanged without changes, else the zip in memory, gate 2, the seal.
export async function savePptxSealed(
	input: PptxSaveInput,
	sealer: PptxSealer,
	sink: ByteSink,
	options: PptxSaveOptions = {}
): Promise<PptxSaveOutcome> {
	if (input.changes.empty) return { kind: "unchanged" }

	const memory = memorySink()
	const outcome = await savePptx(input, memory, { ...options, inMemoryLimit: Number.POSITIVE_INFINITY })

	if (outcome.kind !== "written") return outcome

	const failure = await sealInto(memory.bytes(), sealer, sink, options.slicing)

	return failure ?? outcome
}

// A fresh package sealed (Save as of an encrypted deck to .pptx).
export async function freshPptxSealed(
	fresh: FreshPptx,
	deck: Deck,
	source: PptxSource | undefined,
	sealer: PptxSealer,
	sink: ByteSink,
	options: PptxSaveOptions = {}
): Promise<PptxSaveOutcome> {
	const memory = memorySink()
	const outcome = await fresh(deck, source, memory, options)

	if (outcome.kind !== "written") return outcome

	const failure = await sealInto(memory.bytes(), sealer, sink, options.slicing)

	return failure ?? outcome
}
