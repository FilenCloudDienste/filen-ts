import {
	ZipArchive,
	chunksSource,
	crc32,
	isByteChunks,
	joinBytes,
	memorySink,
	partKey,
	writeZip,
	type ByteChunks,
	type ByteSink,
	type ByteSource,
	type PartBytes,
	type ZipPlan,
	type ZipPlanItem
} from "../../opc/index"
import { PresentationError, refused, type Refused } from "../../presentation/model"
import { spliceSnapshot, type SpliceSnapshot } from "./splice"
import type { PptxSaveInput, PptxSaveOptions, PptxSaveOutcome, PptxSnapshot, SavePptx, SpliceWriter } from "./types"
import { FinalPackage, verifyFinal } from "./verify"

// Saving a pptx into its own format: the snapshot (every changed part serialized at revision R), proof gate 2 on the
// package as it will be stored, then the zip. A package up to the in-memory limit is written to memory and read back
// before a byte reaches the sink; a larger one streams, with every copy checked on arrival (CRC-32 computed where the
// bytes live against the bytes received) and every stored new part's CRC checked before the central directory. Any
// failure throws out of the stream before the central directory, and the sink is never closed: the upload behind it
// aborts without finalizing.

export const IN_MEMORY_LIMIT = 64 * 1024 * 1024
const CHUNK = 1024 * 1024

function isRefused(value: unknown): value is Refused {
	return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "refused"
}

// A source whose checked reads are checked again on arrival: what the far side checksummed must be what came.
export function arrivalChecked(source: ByteSource): ByteSource {
	const checked = source.readChecked?.bind(source)

	if (checked === undefined) return source

	return {
		size: source.size,
		read: (offset, length) => source.read(offset, length),
		async readChecked(offset, length, crc) {
			const read = await checked(offset, length, crc)

			if (crc32(read.bytes, crc) !== read.crc)
				throw new PresentationError("proofFailed", `A copied range at ${String(offset)} arrived damaged`)

			return read
		}
	}
}

// Stored new content given as pieces, its CRC-32 taken as the writer reads it.
class CrcChunks implements ByteChunks {
	readonly length: number
	crc = 0
	private readonly inner: ByteChunks

	constructor(inner: ByteChunks) {
		this.inner = inner
		this.length = inner.length
	}

	async *chunks(): AsyncIterable<Uint8Array> {
		this.crc = 0

		for await (const chunk of this.inner.chunks()) {
			this.crc = crc32(chunk, this.crc)

			yield chunk
		}
	}
}

// The plan's items one at a time; once the last is written (the writer asks for the next before its central directory),
// every stored piece-wise part's CRC and the number of copies are checked.
export async function* checkedItems(plan: ZipPlan, expectedCopies: number): AsyncIterable<ZipPlanItem> {
	const watched: { readonly name: string; readonly chunks: CrcChunks; readonly expected: number }[] = []
	let copies = 0

	for (const item of plan.items) {
		if (item.kind === "copy") {
			copies++

			yield item

			continue
		}

		if (isByteChunks(item.bytes) && item.crc32 !== undefined) {
			const chunks = new CrcChunks(item.bytes)

			watched.push({ name: item.name, chunks, expected: item.crc32 })

			yield { ...item, bytes: chunks }

			continue
		}

		yield item
	}

	for (const entry of watched) {
		if (entry.chunks.crc >>> 0 !== entry.expected >>> 0)
			throw new PresentationError("proofFailed", `${entry.name} changed while it was written`)
	}

	if (copies !== expectedCopies)
		throw new PresentationError("proofFailed", `${String(copies)} parts copied, ${String(expectedCopies)} planned`)
}

async function sameBytes(archive: ZipArchive, name: string, expected: PartBytes): Promise<boolean> {
	const entry = archive.entries.find(candidate => partKey(candidate.name) === partKey(name))

	if (entry === undefined) return false

	const [written, wanted] = await Promise.all([archive.read(entry), joinBytes(expected)])

	if (written.length !== wanted.length) return false

	for (let k = 0; k < written.length; k++) if (written[k] !== wanted[k]) return false

	return true
}

// Writes a snapshot: gate 2, then the zip (in memory and read back, or streamed and checked).
export async function writeSnapshot(snapshot: PptxSnapshot, sink: ByteSink, options: PptxSaveOptions = {}): Promise<PptxSaveOutcome> {
	const splice = snapshot as SpliceSnapshot

	if (splice.expectation === undefined) return refused("failed", "Not a splice writer snapshot")

	const source = splice.source

	try {
		const gate = await verifyFinal(new FinalPackage(source.package, snapshot.changes), splice.expectation)

		if (gate !== undefined) return gate

		const plan = await source.package.plan(snapshot.changes)
		const planned = plan.items.filter(item => item.kind === "copy").length
		const limit = options.inMemoryLimit ?? IN_MEMORY_LIMIT
		const zipOptions = {
			...(options.slicing === undefined ? {} : { slicing: options.slicing }),
			...(options.deflate === undefined ? {} : { deflate: options.deflate })
		}

		const changed = [...(snapshot.changes.replace ?? []), ...(snapshot.changes.add ?? [])]
		// What the package holds in memory is the source and what the save adds (an inserted medium may be large).
		const added = changed.reduce((sum, change) => sum + change.bytes.length, 0)

		if (source.archive.source.size + added <= limit) {
			const memory = memorySink()
			const report = await writeZip(plan, source.archive, memory, zipOptions)
			// Read back over the pieces as written: joining them would hold the package twice.
			const chunks = memory.chunks()
			const back = await ZipArchive.open(chunksSource(chunks))

			for (const change of changed) {
				// A piece-wise part with its CRC (an inserted medium) was checked as it streamed (its own chunks fail on
				// any other byte): the zip's entry says what was written, without reading the medium again.
				if (!(change.bytes instanceof Uint8Array) && change.crc32 !== undefined) {
					const entry = back.entries.find(candidate => partKey(candidate.name) === partKey(change.name))

					if (entry === undefined || entry.crc32 >>> 0 !== change.crc32 >>> 0 || entry.uncompressedSize !== change.bytes.length)
						return refused("proofFailed", `${change.name} reads back from the zip differently`)

					continue
				}

				if (!(await sameBytes(back, change.name, change.bytes)))
					return refused("proofFailed", `${change.name} reads back from the zip differently`)
			}

			if (report.entries - (snapshot.changes.replace?.length ?? 0) - (snapshot.changes.add?.length ?? 0) !== planned) {
				return refused("proofFailed", "The zip copied a different number of parts than planned")
			}

			for (const chunk of chunks) {
				for (let at = 0; at < chunk.length; at += CHUNK) await sink.write(chunk.subarray(at, Math.min(chunk.length, at + CHUNK)))
			}

			await sink.close()

			return { kind: "written", report, revision: snapshot.revision }
		}

		const report = await writeZip(
			{
				items: checkedItems(plan, planned),
				...(plan.comment === undefined ? {} : { comment: plan.comment }),
				...(plan.zip64End === undefined ? {} : { zip64End: plan.zip64End })
			},
			arrivalChecked(source.archive.source),
			sink,
			zipOptions
		)

		return { kind: "written", report, revision: snapshot.revision }
	} catch (error) {
		if (error instanceof PresentationError) return refused(error.reason, error.message)

		throw error
	}
}

export const pptxSpliceWriter: SpliceWriter = {
	snapshot: input => spliceSnapshot(input),
	write: (snapshot, sink, options) => writeSnapshot(snapshot, sink, options)
}

// The save of a deck into its own source: unchanged without changes (nothing uploaded), else snapshot and write.
export const savePptx: SavePptx = async (input: PptxSaveInput, sink: ByteSink, options: PptxSaveOptions) => {
	if (input.changes.empty) return { kind: "unchanged" }

	const snapshot = await spliceSnapshot(input)

	if (isRefused(snapshot)) return snapshot

	const { replace = [], add = [], remove = [] } = snapshot.changes

	if (replace.length === 0 && add.length === 0 && remove.length === 0) return { kind: "unchanged" }

	return writeSnapshot(snapshot, sink, options)
}
