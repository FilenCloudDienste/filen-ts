import {
	chunksSource,
	crc32,
	partKey,
	type ByteSink,
	type ByteSource,
	type Slicing,
	type WriteZipReport,
	type ZipArchive
} from "../../core/opc/index"
import type { DeckChanges } from "../../core/presentation/edit/apply"
import {
	PresentationError,
	type Deck,
	type Format,
	type PresentationRefusal,
	type Refused,
	type SourceRef
} from "../../core/presentation/model"
import { resolvePath, structuralPath, visitSources } from "../../core/pptx/sourcePath"
import type { OdpSaveSource } from "../../core/odp/write/splice"
import { IN_MEMORY_LIMIT } from "../../core/pptx/write/save"
import type { PptxSaveOptions, PptxSnapshot, PptxSource, SpliceWriter } from "../../core/pptx/write/types"
import type { XmlDocument } from "../../core/xml/index"
import type { CallContext, EngineSession, OpenedPackage } from "./engine"
import type { DriveFileRef, PortLike, PresentationNotice, SaveResult } from "./protocol"
import { SavePortAbortedError, savePortWriter, type SavePortAbortReason, type SavePortEnd, type SavePortWriter } from "./savePort"

// Saving a session: the snapshot of the changed parts at revision R, taken while commands wait; the package the
// format's writer makes (with its second proof gate: a package up to the in-memory limit checked whole before a byte
// leaves, a larger one streamed with every copy and new entry checked before its central directory) written to the
// save port (savePort.ts); the upload allowed to end only once the writer finished; and the rebase that makes the saved
// file the session's base source, so a drive with versioning off (which deletes the old version) never leaves the
// session reading a file that is gone.
//
// A package up to IN_MEMORY_LIMIT (the pptx writer's) is kept as it goes out (the writer holds it whole anyway), so the rebase reads
// it from memory with no download; an encrypted one is zipped in memory and sealed (its container needs the sealed size
// up front), its zip kept the same way.

// Progress events at most this often (bytes sent).
const PROGRESS_STEP = 4 * 1024 * 1024

// The deck's history as the save needs it (the edit capability binds it, bindSaveHistory).
export interface SaveHistory {
	readonly revision: number
	// The current state differs from the saved one.
	readonly dirty: boolean
	// The net bytes dirty against the saved state, estimated (absent: unknown).
	readonly dirtyBytes?: number
	// The net changes against the saved state, recomputed.
	changes(): DeckChanges
	// The state a save starts from; committed when the save lands, abandoned when it does not.
	savePoint(): { readonly revision: number }
	commit(point: { readonly revision: number }): void
	abandon(point: { readonly revision: number }): void
	// Reverts the ops whose net effect touches these parts (the writer's own check refused them), answering how many
	// steps were reverted. Absent: nothing is reverted and the save is only refused.
	revert?(parts: ReadonlySet<string>): Promise<number>
}

const histories = new WeakMap<Deck, SaveHistory>()

// Called by the edit capability when it makes the deck's history.
export function bindSaveHistory(deck: Deck, history: SaveHistory): void {
	histories.set(deck, history)
}

export function saveHistoryOf(deck: Deck): SaveHistory | undefined {
	return histories.get(deck)
}

const turns = new WeakMap<Deck, Promise<unknown>>()

// Runs `task` when every earlier turn of the deck has ended: commands (the edit capability) and a save's snapshot
// take turns, so a snapshot never interleaves with an op.
export function deckTurn<T>(deck: Deck, task: () => Promise<T>): Promise<T> {
	const before = turns.get(deck) ?? Promise.resolve()
	const run = before.then(task, task)

	turns.set(
		deck,
		run.then(
			() => undefined,
			() => undefined
		)
	)

	return run
}

// A source a host may serve remotely (the web's range port): beginCopies() starts a pass of a save's checked reads in
// file order, which the host may serve from aligned blocks it fetches once each; end() drops them and answers the
// bytes the pass downloaded. close() lets go of a source made but never read (the saved file's port of a save kept in
// memory), so the host's serving side shuts down at once.
export interface CopyPass {
	end(): number
}

export interface RemoteByteSource extends ByteSource {
	beginCopies?(): CopyPass
	close?(): void
}

// Where a retired source's reads go: the same bytes in the saved file (a copied entry moved, its bytes did not), or
// undefined when they are not there (a rewritten entry: the offsets were the old file's).
type Relocate = (offset: number, length: number) => { readonly source: ByteSource; readonly offset: number } | undefined

// A base source a save can hold and a rebase retires: reads wait while it is held (the upload has ended and the old
// file may be going); once retired, a read of a copied entry is served from the saved file and any other is refused
// as stale.
interface SourceGate {
	held: Promise<void> | undefined
	release: (() => void) | undefined
	retired: boolean
	relocate: Relocate | undefined
	// Reads of the source itself still running, and whether it is closed once they end (it was retired).
	reading: number
	closing: boolean
	close: (() => void) | undefined
}

const gates = new WeakMap<ByteSource, SourceGate>()

function staleError(): PresentationError {
	return new PresentationError("stale", "the deck was rebased onto its saved file")
}

export function rebasableSource(source: RemoteByteSource): RemoteByteSource {
	const gate: SourceGate = {
		held: undefined,
		release: undefined,
		retired: false,
		relocate: undefined,
		reading: 0,
		closing: false,
		close: source.close === undefined ? undefined : () => source.close?.()
	}
	// A read of the source itself: a retired source is closed once the last one ends.
	const own = async <T>(read: () => Promise<T>): Promise<T> => {
		gate.reading++

		try {
			return await read()
		} finally {
			gate.reading--
			closeIfIdle(gate)
		}
	}
	// The source to read [offset, offset + length) from once any hold ended.
	const target = async (offset: number, length: number): Promise<{ readonly source: ByteSource; readonly offset: number }> => {
		while (gate.held !== undefined) await gate.held

		if (!gate.retired) return { source, offset }

		const moved = gate.relocate?.(offset, length)

		if (moved === undefined) throw staleError()

		return moved
	}
	const read: ByteSource["read"] = async (offset, length) => {
		const at = await target(offset, length)

		return at.source === source ? own(() => source.read(offset, length)) : at.source.read(at.offset, length)
	}
	const wrapped: RemoteByteSource = { size: source.size, read }
	const checked = source.readChecked

	if (checked !== undefined) {
		wrapped.readChecked = async (offset, length, crc) => {
			const at = await target(offset, length)

			if (at.source === source) return own(() => checked.call(source, offset, length, crc))

			const moved = at.source.readChecked

			if (moved !== undefined) return moved.call(at.source, at.offset, length, crc)

			// The saved file held in memory: nothing between here and its bytes to check.
			const bytes = await at.source.read(at.offset, length)

			return { bytes, crc: crc32(bytes, crc) }
		}
	}

	const begin = source.beginCopies

	if (begin !== undefined) wrapped.beginCopies = () => begin.call(source)

	gates.set(wrapped, gate)

	return wrapped
}

function closeIfIdle(gate: SourceGate): void {
	if (!gate.closing || gate.reading > 0) return

	gate.closing = false
	gate.close?.()
	gate.close = undefined
}

// A retired source is read no more: its host lets go of it (a range port's serving side) once reads in flight end.
function closeRetired(source: ByteSource): void {
	const gate = gates.get(source)

	if (gate === undefined) return

	gate.closing = true
	closeIfIdle(gate)
}

function holdReads(source: ByteSource): () => void {
	const gate = gates.get(source)

	if (gate === undefined || gate.held !== undefined) return () => undefined

	const held = Promise.withResolvers<undefined>()

	gate.held = held.promise
	gate.release = () => {
		gate.held = undefined
		gate.release = undefined
		held.resolve(undefined)
	}

	return gate.release
}

function retire(source: ByteSource, relocate?: Relocate): void {
	const gate = gates.get(source)

	if (gate === undefined) return

	gate.retired = true
	gate.relocate = relocate
	gate.release?.()
}

// Each copied entry's raw bytes (local header to the end of its data) as one span in the old file and the saved one:
// the writer copied them verbatim, so a read inside one span reads the same bytes at the new offset. A span ends where
// the next entry (or the central directory) begins in either file, which in the written file is exactly its length.
function relocation(from: ZipArchive, to: ZipArchive, target: ByteSource, written: ReadonlySet<string>): Relocate {
	const bounds = (archive: ZipArchive): Map<string, { readonly start: number; readonly end: number }> => {
		const sorted = [...archive.entries].sort((a, b) => a.localHeaderOffset - b.localHeaderOffset)
		const out = new Map<string, { readonly start: number; readonly end: number }>()

		sorted.forEach((entry, k) => {
			out.set(entry.name, { start: entry.localHeaderOffset, end: sorted[k + 1]?.localHeaderOffset ?? archive.dataEnd })
		})

		return out
	}
	const before = bounds(from)
	const after = bounds(to)
	const spans: { readonly start: number; readonly end: number; readonly moved: number }[] = []

	for (const [name, old] of before) {
		const now = after.get(name)

		if (now === undefined || written.has(name)) continue

		spans.push({ start: old.start, end: old.start + Math.min(old.end - old.start, now.end - now.start), moved: now.start })
	}

	spans.sort((a, b) => a.start - b.start)

	return (offset, length) => {
		let low = 0
		let high = spans.length - 1

		while (low <= high) {
			const middle = (low + high) >>> 1
			const span = spans[middle]

			if (span === undefined) break

			if (offset < span.start) high = middle - 1
			else if (offset >= span.end) low = middle + 1
			else return offset + length <= span.end ? { source: target, offset: span.moved + offset - span.start } : undefined
		}

		return undefined
	}
}

// Seals a written zip for an encrypted deck (MS-OFFCRYPTO Agile) with the key the session opened it with.
export type SealPackage = (zip: Uint8Array, deck: Deck, slicing: Slicing) => Promise<Uint8Array>

// A format's save: the splice writer, what it reads the session's package as (pptx: the archive and package plus the
// deck's part map; odp: the reader's parts), and the sealing of encrypted packages.
export interface DeckSaver<S = PptxSource> {
	readonly writer: {
		snapshot(input: {
			readonly deck: Deck
			readonly source: S
			readonly changes: DeckChanges
			readonly revision: number
		}): Promise<PptxSnapshot | Refused>
		write: SpliceWriter["write"]
	}
	readonly source?: (session: EngineSession) => S
	readonly seal?: SealPackage
}

// The session's base source moved to the saved file: re-open the package over it and rebind the model's refs.
export type DeckRebaser = (session: EngineSession, source: ByteSource, saved: SavedPackage) => Promise<OpenedPackage>

export interface SaveDependencies {
	readonly savers: { readonly pptx?: DeckSaver; readonly ppt?: DeckSaver; readonly odp?: DeckSaver<OdpSaveSource> }
	readonly rebasers: { readonly [F in Format]?: DeckRebaser }
	// Packages up to this size are written in memory (default IN_MEMORY_LIMIT).
	readonly inMemoryLimit?: number
}

// What a written save leaves for the rebase.
export interface SavedPackage {
	readonly revision: number
	readonly point: { readonly revision: number }
	// The saved zip (the decrypted one of an encrypted deck) in the pieces it was written in, kept when it was written
	// in memory.
	readonly zip: readonly Uint8Array[] | undefined
	readonly size: number
	// Entry names the writer wrote anew (replaced or added): the rest are byte copies.
	readonly written: ReadonlySet<string>
	readonly report: WriteZipReport
}

interface PendingSave {
	readonly saved: SavedPackage
	// Ends the hold on the old source's reads.
	readonly release: () => void
}

// A package written in memory whose upload did not make the file: a retry at the same revision sends it again instead
// of reading every copy from the source once more. Dropped by any other save, a commit and the session's close.
interface RetainedSave {
	readonly revision: number
	readonly package: OpenedPackage
	readonly zip: readonly Uint8Array[]
	// What goes out: the zip, or for an encrypted deck the sealed file.
	readonly upload: readonly Uint8Array[]
	readonly written: ReadonlySet<string>
	readonly report: WriteZipReport
}

interface SessionSaves {
	// A save is between its snapshot and its upload's answer.
	running: boolean
	pending: PendingSave | undefined
	retained: RetainedSave | undefined
}

const sessions = new WeakMap<EngineSession, SessionSaves>()

function savesOf(session: EngineSession): SessionSaves {
	let saves = sessions.get(session)

	if (saves === undefined) {
		saves = { running: false, pending: undefined, retained: undefined }
		sessions.set(session, saves)
		session.onClose(() => {
			saves?.pending?.release()

			if (saves !== undefined) saves.retained = undefined

			sessions.delete(session)
		})
	}

	return saves
}

function isRefused(value: object): value is Refused {
	return (value as { kind?: unknown }).kind === "refused"
}

function refusedResult(reason: PresentationRefusal): SaveResult {
	return { kind: "refused", reason }
}

// A ByteSink that counts and reports progress over the port writer.
function progressOf(session: EngineSession, writer: SavePortWriter, total: number | undefined): void {
	let reported = 0

	writer.onSent = sent => {
		if (sent - reported < PROGRESS_STEP) return

		reported = sent
		session.emit({ type: "saveProgress", sent, ...(total === undefined ? {} : { total }) })
	}
}

// A sink keeping everything written (the writer never touches a chunk again once written), and passing it on to
// `sink` when given: the saved zip of a package small enough to rebase from memory, or the zip an encrypted deck seals.
// Kept as the pieces written (one copy of the package); consecutive views of one buffer come back as one view.
function keepingSink(sink: ByteSink | undefined): ByteSink & { chunks(): readonly Uint8Array[] } {
	const kept: Uint8Array[] = []

	return {
		async write(chunk) {
			const last = kept.at(-1)

			if (last !== undefined && chunk.buffer === last.buffer && chunk.byteOffset === last.byteOffset + last.length) {
				kept[kept.length - 1] = new Uint8Array(last.buffer, last.byteOffset, last.length + chunk.length)
			} else {
				kept.push(chunk)
			}

			await sink?.write(chunk)
		},
		close: () => sink?.close() ?? Promise.resolve(),
		chunks: () => kept
	}
}

// The pieces as one array: only for a consumer that needs one (sealing).
function joined(chunks: readonly Uint8Array[]): Uint8Array {
	if (chunks.length === 1 && chunks[0] !== undefined) return chunks[0]

	const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
	let at = 0

	for (const chunk of chunks) {
		out.set(chunk, at)
		at += chunk.length
	}

	return out
}

function lengthOf(chunks: readonly Uint8Array[]): number {
	return chunks.reduce((sum, chunk) => sum + chunk.length, 0)
}

// Bytes this save read from the base source when the source cannot tell (no copy pass): the copies.
function downloadedBytes(pkg: OpenedPackage, report: WriteZipReport, written: ReadonlySet<string>): number {
	if (pkg.sourceKind !== "range") return 0

	let sum = 0

	if (report.copies.size > 0) {
		for (const copy of report.copies.values()) sum += copy.length

		return sum
	}

	for (const entry of pkg.archive?.entries ?? []) {
		if (!written.has(entry.name)) sum += 30 + entry.nameBytes.length + entry.extra.length + entry.compressedSize
	}

	return sum
}

function writtenNames(snapshot: PptxSnapshot): Set<string> {
	return new Set([...(snapshot.changes.replace ?? []), ...(snapshot.changes.add ?? [])].map(change => change.name))
}

export function packageSource(session: EngineSession): PptxSource {
	const pkg = session.package

	if (pkg.archive === undefined || pkg.opc === undefined) {
		throw new PresentationError("notImplemented", "a deck without its package archive cannot be saved in place")
	}

	return { archive: pkg.archive, package: pkg.opc }
}

// The save method: writes the session's changes to `port` (the SDK worker's upload reads it). The upload ends with a
// file only when every check passed; then the old source's reads are held until commitSaved rebases the session.
export async function saveSession(
	context: CallContext,
	options: { readonly reason: "user" | "auto"; readonly port: PortLike },
	dependencies: SaveDependencies
): Promise<SaveResult> {
	const { session } = context
	const deck = session.deck
	const writer = savePortWriter(options.port as SavePortEnd)
	const end = (reason: SavePortAbortReason, result: SaveResult): SaveResult => {
		writer.abort(reason)

		return result
	}

	if (deck.gate.length > 0) return end("refused", refusedResult("viewOnly"))

	const history = histories.get(deck)

	if (history === undefined || !history.dirty) return end("unchanged", { kind: "unchanged" })

	const saver = dependencies.savers[deck.format]

	if (saver === undefined) return end("refused", refusedResult("notImplemented"))
	if (deck.protection.encrypted !== undefined && saver.seal === undefined) return end("refused", refusedResult("notImplemented"))

	// The format's saver over its own source type (a saver without `source` reads the pptx package).
	const active = saver as DeckSaver<unknown>

	const saves = savesOf(session)

	if (saves.running) return end("refused", refusedResult("locked"))

	// A written save the page never committed (it chose not to rebase): its hold ends, and this save reads the old
	// file as the session still does.
	saves.pending?.release()
	saves.pending = undefined

	saves.running = true
	context.signal.onAbort(() => {
		writer.abort("cancelled")
	})

	let point: { readonly revision: number } | undefined

	try {
		const taken = await deckTurn(deck, async () => {
			const changes = history.changes()

			// Dirty keys with nothing net to write (no part names them, an order no shape moved in): the file holds
			// this state, so it is the saved one from now and the page reads clean, not dirty with nothing to save.
			if (changes.empty) {
				history.commit(history.savePoint())

				return undefined
			}

			point = history.savePoint()

			const retained = saves.retained

			saves.retained = undefined

			if (retained?.revision === point.revision && retained.package === session.package) {
				return { revision: point.revision, retained }
			}

			return {
				revision: point.revision,
				snapshot: await active.writer.snapshot({
					deck,
					source: active.source === undefined ? packageSource(session) : active.source(session),
					changes,
					revision: point.revision
				})
			}
		})

		if (taken === undefined) return unchanged()

		// From here the save writes: the page opens the upload now (savePortAnnounced).
		if ("retained" in taken) {
			writer.announce()

			return await resend(taken.retained)
		}

		if (isRefused(taken.snapshot)) return await refuse(taken.snapshot.reason, taken.snapshot.detail)

		writer.announce()

		return await write(taken.snapshot, taken.revision)
	} catch (error) {
		if (point !== undefined) history.abandon(point)

		const reason =
			error instanceof SavePortAbortedError
				? "aborted"
				: error instanceof PresentationError
					? error.reason
					: context.signal.aborted
						? "aborted"
						: "failed"

		return end(reason === "aborted" ? "cancelled" : "failed", refusedResult(reason))
	} finally {
		saves.running = false
	}

	// Nothing written while the deck read dirty: the saved state moved, so the page's indicator follows.
	function unchanged(): SaveResult {
		if (history !== undefined) emitSavedState(session, history)

		return end("unchanged", { kind: "unchanged" })
	}

	// The writer's check refused the changes of some parts: their ops are reverted (when the history can) and the
	// user is told how many.
	async function refuse(reason: PresentationRefusal, detail: string | undefined): Promise<SaveResult> {
		if (point !== undefined) history?.abandon(point)

		const parts = detail === undefined ? undefined : partsNamed(detail)
		const revert = history?.revert
		// In the deck's turn, as any change of the model.
		const reverted =
			reason === "proofFailed" && parts !== undefined && revert !== undefined
				? await deckTurn(deck, () => revert.call(history, parts))
				: undefined

		if (reverted !== undefined && reverted > 0) session.emit({ type: "notice", notice: { kind: "saveReverted", ops: reverted } })

		return end("refused", refusedResult(reason))
	}

	async function write(snapshot: PptxSnapshot, revision: number): Promise<SaveResult> {
		const pkg = session.package
		const limit = dependencies.inMemoryLimit ?? IN_MEMORY_LIMIT
		const seal = deck.protection.encrypted === undefined ? undefined : active.seal
		// Sealed: the whole zip in memory first, whatever its size (the deck itself is held decrypted in memory).
		const writeOptions: PptxSaveOptions = {
			slicing: context.slicing,
			inMemoryLimit: seal === undefined ? limit : Number.POSITIVE_INFINITY
		}
		const kept = seal !== undefined ? keepingSink(undefined) : pkg.bytes <= limit ? keepingSink(writer) : undefined
		const sink: ByteSink = kept ?? writer

		if (seal === undefined) progressOf(session, writer, undefined)

		// The copies read in one pass over the source, which a remote one serves from blocks fetched once each.
		const pass = (pkg.source as RemoteByteSource).beginCopies?.()
		let downloaded: number | undefined
		let outcome: Awaited<ReturnType<SpliceWriter["write"]>>

		try {
			outcome = await active.writer.write(snapshot, sink, writeOptions)
		} finally {
			downloaded = pass?.end()
		}

		if (outcome.kind === "unchanged") {
			// The file already holds the snapshot's state: it is the saved one.
			if (point !== undefined) history?.commit(point)

			return unchanged()
		}

		if (outcome.kind === "refused") return refuse(outcome.reason, outcome.detail)

		const zip = kept?.chunks()
		let upload = zip

		if (seal !== undefined && zip !== undefined) {
			const sealed = await seal(joined(zip), deck, context.slicing)

			upload = [sealed]
			progressOf(session, writer, sealed.length)
			await writer.write(sealed)
			await writer.close()
		}

		const written = writtenNames(snapshot)
		const transfer = { downloaded: downloaded ?? downloadedBytes(pkg, outcome.report, written) }

		return land({ revision, zip, upload, written, report: outcome.report, package: pkg }, transfer.downloaded)
	}

	// A retained package sent again: nothing is read from the source.
	async function resend(retained: RetainedSave): Promise<SaveResult> {
		progressOf(session, writer, lengthOf(retained.upload))

		for (const chunk of retained.upload) await writer.write(chunk)

		await writer.close()

		return land({ ...retained }, 0)
	}

	// The written package's upload ends; the file it made is pending for commitSaved.
	async function land(
		saved: Omit<RetainedSave, "zip" | "upload"> & {
			readonly zip: readonly Uint8Array[] | undefined
			readonly upload: readonly Uint8Array[] | undefined
		},
		downloaded: number
	): Promise<SaveResult> {
		const { revision, zip, upload, written, report } = saved
		const release = holdReads(saved.package.source)

		writer.commit()

		// The page giving up on the save (its call aborted) counts as no file.
		const uploaded = await Promise.race([
			writer.uploaded,
			new Promise<boolean>(resolve => {
				context.signal.onAbort(() => {
					resolve(false)
				})
			})
		])

		if (!uploaded) {
			release()

			// Kept for a retry at this revision (an autosave after a failed upload sends it again, downloading nothing).
			if (zip !== undefined && upload !== undefined) {
				savesOf(session).retained = { revision, package: saved.package, zip, upload, written, report }
			}

			throw new PresentationError("failed", "the upload did not make the file")
		}

		const saves = savesOf(session)

		saves.pending = {
			saved: {
				revision,
				point: point ?? { revision },
				zip,
				size: report.size,
				written,
				report
			},
			release
		}

		session.emit({ type: "saveProgress", sent: writer.sent, total: writer.sent })

		const notices: PresentationNotice[] = []
		const result = {
			kind: "written" as const,
			bytes: writer.sent,
			revision,
			notices,
			// Network bytes of this save: the package uploaded, and what a range-backed deck downloaded for its copies.
			transfer: { uploaded: writer.sent, downloaded }
		}

		return result
	}
}

// The part names a writer refusal's detail mentions ("/ppt/slides/slide2.xml reads back … differently", an ODP page
// "/content.xml#12"), as model part names; undefined when it names none.
function partsNamed(detail: string): ReadonlySet<string> | undefined {
	const names = detail.match(/[\w.-]+(?:\/[\w.-]+)*\.(?:xml|rels)(?:#[\w.-]+|\b)/gu)

	return names === null ? undefined : new Set(names.map(name => (name.startsWith("/") ? name : `/${name}`)))
}

// The commitSaved method: the saved file is the session's base from now on. The source is the written zip when it
// was kept in memory, otherwise the new file's range port; the package is re-opened over it and the model's refs
// rebound, then the history's saved state is the save's.
export async function commitSavedSession(
	context: CallContext,
	options: { readonly file: DriveFileRef; readonly port: PortLike; readonly size: number; readonly revision: number },
	dependencies: SaveDependencies
): Promise<{ readonly dirty: boolean }> {
	const { session } = context
	const saves = savesOf(session)
	const pending = saves.pending
	const history = histories.get(session.deck)

	if (pending?.saved.revision !== options.revision) {
		closeUnused(session, options)

		throw new PresentationError("stale", `no written save at revision ${String(options.revision)}`)
	}

	const rebaser = dependencies.rebasers[session.deck.format]
	const old = session.package
	let raw: ByteSource

	if (pending.saved.zip !== undefined) {
		closeUnused(session, options)
		raw = chunksSource(pending.saved.zip)
	} else {
		if (session.rangeSource === undefined) {
			options.port.close()

			throw new PresentationError("notImplemented", "range sources")
		}

		raw = session.rangeSource({ kind: "range", port: options.port, size: options.size, checked: true })
	}

	saves.pending = undefined
	saves.retained = undefined

	// The save landed whatever the rebase does next.
	history?.commit(pending.saved.point)

	try {
		if (rebaser === undefined) throw new PresentationError("notImplemented", `rebase ${session.deck.format}`)

		session.package = await rebaser(session, rebasableSource(raw), pending.saved)
	} catch (error) {
		// The new file's source is not the session's: its host lets go of it.
		;(raw as RemoteByteSource).close?.()
		// The old file may be gone: the session cannot read on safely.
		retire(old.source)
		closeRetired(old.source)
		session.emit({ type: "error", reason: "stale", message: error instanceof Error ? error.message : String(error) })

		throw error
	}

	// Reads of the old file still to come (held until now, or from handles parsed before the rebase) read the saved
	// file where it holds the same bytes.
	const archive = session.package.archive

	retire(
		old.source,
		old.archive === undefined || archive === undefined
			? undefined
			: relocation(old.archive, archive, session.package.source, pending.saved.written)
	)
	closeRetired(old.source)

	const dirty = history?.dirty ?? false

	// The saved state moved: the page's dirty indicator and unsaved guard follow (no slide changed).
	if (history === undefined) session.emit({ type: "changed", revision: 0, dirty, slides: [] })
	else emitSavedState(session, history)

	return { dirty }
}

function emitSavedState(session: EngineSession, history: SaveHistory): void {
	session.emit({
		type: "changed",
		revision: history.revision,
		dirty: history.dirty,
		...(history.dirtyBytes === undefined ? {} : { dirtyBytes: history.dirtyBytes }),
		slides: []
	})
}

// The saved file's port when the session does not read through it: closed through the host, which shuts its serving
// side down at once (a port merely closed here would keep that side waiting for its idle timeout).
function closeUnused(session: EngineSession, options: { readonly port: PortLike; readonly size: number }): void {
	if (session.rangeSource === undefined) {
		options.port.close()

		return
	}

	const source: RemoteByteSource = session.rangeSource({ kind: "range", port: options.port, size: options.size, checked: true })

	if (source.close === undefined) options.port.close()
	else source.close()
}

// Every pptx SourceRef of the model moves to `epoch`; refs into a part the save rewrote are rebound into its new
// document by structure (a shape by its cNvPr id, every other element by its name and position among same-named
// siblings), and stay on their old epoch (refused as stale where read) when the new document has no such element.
// `rewritten` is keyed by partKey.
export function rebindSources(
	deck: Deck,
	epoch: number,
	rewritten: ReadonlyMap<string, { readonly from: XmlDocument; readonly to: XmlDocument }>
): void {
	const memo = new Map<string, Map<number, number | undefined>>()
	const remap = (src: SourceRef): SourceRef => {
		if (src.format !== "pptx") return src

		const documents = rewritten.get(partKey(src.part))

		if (documents === undefined) return { ...src, epoch }

		let nodes = memo.get(src.part)

		if (nodes === undefined) {
			nodes = new Map()
			memo.set(src.part, nodes)
		}

		let node = nodes.get(src.node)

		if (!nodes.has(src.node)) {
			node = resolvePath(documents.to, structuralPath(documents.from, src.node))
			nodes.set(src.node, node)
		}

		return node === undefined ? src : { ...src, node, epoch }
	}

	visitSources(deck, remap)
}
