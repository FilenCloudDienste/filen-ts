import { crc32, partKey, type ByteChunks, type ByteSource, type PartChange, type Slicing, type ZipEntry } from "../../core/opc/index"
import { deflateBound, InflateIndex } from "../../core/opc/inflateIndex"
import { MEDIA_LIMITS, sniffMedia, type MediaContainer } from "../../core/opc/mediaPolicy"
import { pictureSize } from "../../core/odp/read/document"
import { commitInsertedMedia, insertedMediaAdded, insertedMediaId, registerInsertedMedia } from "../../core/presentation/edit/apply/media"
import { commitInsertedImages, insertedImagesAdded } from "../../core/presentation/edit/apply/picture"
import type { FileLike, InsertedMedia } from "../../core/presentation/edit/ops"
import type { Deck, MediaRef, ShapeNode, SlideRef } from "../../core/presentation/model"
import type { CallSignal, EngineSession } from "./engine"
import { pptxParts } from "./engine/open/pptx"
import { viewParts } from "./engine/view"
import type { MediaInsertSource, MediaRefusal, PortStreamMeta } from "./protocol"

// The media of a session's deck, served by range to the page (which registers the port with its service worker, so a
// <video> streams and seeks it like any drive file) and never read whole:
//   - a stored entry: its bytes where the zip has them, read through the deck's base source per request (after a save
//     moved them, from the saved file);
//   - a deflated entry: through an inflate index (core/opc/inflateIndex.ts), built once in the background lane; the
//     stream is only offered once the index is complete, so no read of the browser ever waits on the build (the range
//     port fails a read that makes no progress for 60 s). Meanwhile media() answers "preparing" and the session sends
//     "media" notices with the build's progress, the last at 1 when it is done;
//   - an inserted medium: the device file or drive file it was registered from (registerMedia), read once then for
//     its CRC-32 and again, streamed, by the save.
// A part is served only when a parsed shape of the deck plays it, the package classes it media (pptx: its content
// type and relationships) and its first bytes are an audio or video container.

// What a range read of a medium answers: [start, end) of its bytes.
export type MediaReader = (start: number, end: number, signal: CallSignal) => Promise<Uint8Array>

interface IndexBuild {
	index: InflateIndex | undefined
	failed: boolean
	// 0..1.
	progress: number
	// When it last served (or was asked for), for the eviction order.
	used: number
}

interface InsertedEntry {
	readonly size: number
	readonly contentType: string
	read(offset: number, length: number): Promise<Uint8Array>
	close?(): void
}

interface MediaState {
	readonly builds: Map<string, IndexBuild>
	readonly inserted: Map<number, InsertedEntry>
	// Containers of parts already sniffed (a part is sniffed once).
	readonly containers: Map<string, MediaContainer | null>
	readonly closed: { aborted: boolean; readonly listeners: (() => void)[] }
	next: number
}

const states = new WeakMap<EngineSession, MediaState>()

function stateOf(session: EngineSession): MediaState {
	let state = states.get(session)

	if (state === undefined) {
		const created: MediaState = {
			builds: new Map(),
			inserted: new Map(),
			containers: new Map(),
			closed: { aborted: false, listeners: [] },
			next: 1
		}

		state = created
		states.set(session, created)
		session.onClose(() => {
			created.closed.aborted = true

			for (const listener of created.closed.listeners.splice(0)) listener()
			for (const entry of created.inserted.values()) entry.close?.()

			created.inserted.clear()
			created.builds.clear()
		})
	}

	return state
}

// A signal that aborts when the session closes.
export function sessionClosed(session: EngineSession): CallSignal {
	const closed = stateOf(session).closed

	return {
		get aborted() {
			return closed.aborted
		},
		onAbort(listener) {
			if (closed.aborted) listener()
			else closed.listeners.push(listener)
		}
	}
}

// Bytes a container is sniffed from (mediaPolicy.sniffMedia: 400 lets MPEG-TS show its second sync byte).
const SNIFF_BYTES = 400
// The share of an index build between two "preparing" notices.
const PROGRESS_STEP = 0.1
// Device and drive files are read in steps of this much (CRC at insert, the save's stream).
const READ_STEP = 4 * 1024 * 1024
// Deflated media up to this size are prepared as soon as a slide playing them is rendered (the deck's first slides at
// open, the next ones as the show or the editor reaches them), so a play or a seek finds the index built.
export const PREPARE_AT_RENDER = 256 * 1024 * 1024
// What the session's built indexes may hold in windows together: past it, those used longest ago are dropped (a
// stream still reading one keeps it until it closes; the next play builds it again).
export const INDEX_BUDGET = 64 * 1024 * 1024
// Builds of the session, for the eviction order.
let clock = 0

const CONTAINER_TYPES: Readonly<Record<MediaContainer, readonly [string, string]>> = {
	// [video type, audio type]
	isoBmff: ["video/mp4", "audio/mp4"],
	matroska: ["video/webm", "audio/webm"],
	ogg: ["video/ogg", "audio/ogg"],
	avi: ["video/x-msvideo", "video/x-msvideo"],
	wav: ["audio/wav", "audio/wav"],
	asf: ["video/x-ms-asf", "audio/x-ms-wma"],
	mpegPs: ["video/mpeg", "video/mpeg"],
	mpegTs: ["video/mp2t", "video/mp2t"],
	mpegVideo: ["video/mpeg", "video/mpeg"],
	mp3: ["audio/mpeg", "audio/mpeg"],
	aiff: ["audio/aiff", "audio/aiff"],
	flac: ["audio/flac", "audio/flac"],
	midi: ["audio/midi", "audio/midi"],
	amr: ["audio/amr", "audio/amr"]
}

function isMediaType(type: string | undefined): type is string {
	return type !== undefined && /^(?:audio|video)\/[\w.+-]+$/iu.test(type) && !/\/unknown$/iu.test(type)
}

// The type a medium is served as: what the file declares when it is a concrete audio or video type, else its
// container's.
export function servedType(declared: string | undefined, container: MediaContainer, kind: MediaRef["kind"]): string {
	if (isMediaType(declared)) return declared.toLowerCase()

	const [video, audio] = CONTAINER_TYPES[container]

	return kind === "audio" ? audio : video
}

function eachShape(shapes: readonly ShapeNode[], visit: (shape: ShapeNode) => boolean): boolean {
	for (const shape of shapes) {
		if (visit(shape)) return true
		if (shape.children !== undefined && eachShape(shape.children, visit)) return true
	}

	return false
}

// The medium a parsed shape of the deck plays from `part`.
function playedFrom(deck: Deck, part: string): MediaRef | undefined {
	const key = partKey(part)
	let found: MediaRef | undefined

	for (const node of deck.nodes.values()) {
		if (
			eachShape(node.shapes, shape => {
				const media = shape.media ?? (shape.frame?.kind === "media" ? shape.frame.media : undefined)

				if (media?.part !== undefined && partKey(media.part) === key) found = media

				return found !== undefined
			})
		)
			break
	}

	return found
}

// Bytes whose whole buffer is theirs: the host transfers what a read answers, and a view of the deck's bytes or of a
// cached block would take that buffer from under them.
function owned(bytes: Uint8Array): Uint8Array {
	return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice()
}

export type MediaServing = { readonly kind: "ready"; readonly meta: PortStreamMeta; readonly read: MediaReader } | MediaRefusal

function refusal(reason: MediaRefusal["reason"]): MediaRefusal {
	return { kind: "refused", reason }
}

// How `part` is served now: its reader, or why not (preparing: its index is being built).
export async function mediaServing(session: EngineSession, part: string): Promise<MediaServing> {
	const state = stateOf(session)
	const inserted = insertedMediaId(part)

	if (inserted !== undefined) {
		const entry = state.inserted.get(inserted)

		if (entry === undefined) return refusal("notFound")

		return {
			kind: "ready",
			meta: { size: entry.size, contentType: entry.contentType, seekable: true },
			read: async (start, end) => owned(await entry.read(start, end - start))
		}
	}

	const deck = session.deck
	const media = playedFrom(deck, part)

	if (media === undefined) return refusal("notFound")

	const parts = viewParts(deck)
	const key = partKey(part)
	const entry = parts?.opc.entry(key)

	if (parts === undefined || entry === undefined) return refusal("notFound")

	const pptx = pptxParts(deck)

	// pptx: the package policy's media class (content type and relationship), checked from the central directory.
	if (pptx !== undefined && !pptx.media.has(key)) return refusal("notMedia")
	if (entry.uncompressedSize > MEDIA_LIMITS.mediaEntry) return refusal("tooLarge")

	const archive = archiveOf(session, entry.name)

	if (session.package.archive === undefined) return refusal("notImplemented")
	if (entry.method !== 0 && entry.method !== 8) return refusal("notMedia")

	const stored = entry.method === 0
	let read: MediaReader

	if (stored) {
		read = async (start, end, signal) => {
			if (signal.aborted) throw new Error("aborted")

			const at = archive()

			return owned(await mediaRead(at.source, (await at.layout).dataOffset + start, end - start))
		}
	} else {
		if (entry.compressedSize > deflateBound(entry.uncompressedSize)) return refusal("notMedia")

		const build = state.builds.get(key)

		if (build?.failed === true) return refusal("notMedia")

		if (build?.index === undefined) {
			if (build === undefined) startIndex(session, state, key, part, archive)

			return refusal("preparing")
		}

		const index = build.index

		build.used = ++clock
		read = (start, end, signal) => index.read(start, end - start, undefined, signal)
	}

	let container = state.containers.get(key)

	if (container === undefined) {
		container = sniffMedia(await read(0, Math.min(SNIFF_BYTES, entry.uncompressedSize), sessionClosed(session))) ?? null
		state.containers.set(key, container)
	}

	if (container === null) return refusal("notMedia")

	const contentType = servedType(parts.contentTypes.typeOf(key) ?? media.contentType, container, media.kind)

	return { kind: "ready", meta: { size: entry.uncompressedSize, contentType, seekable: true }, read }
}

// A source whose host keeps media reads in their own small cache (RemoteByteSource.readMedia), so a medium's blocks
// never evict the deck's parts; any other source is read as it is.
type MediaReading = ByteSource & { readMedia(offset: number, length: number): Promise<Uint8Array> }

function mediaRead(source: ByteSource, offset: number, length: number): Promise<Uint8Array> {
	return "readMedia" in source && typeof source.readMedia === "function"
		? (source as MediaReading).readMedia(offset, length)
		: source.read(offset, length)
}

type ArchiveAt = () => { readonly entry: ZipEntry; readonly source: ByteSource; readonly layout: Promise<{ readonly dataOffset: number }> }

// The entry `name` of the session's package as it is when read (after a save, the saved file's).
function archiveOf(session: EngineSession, name: string): ArchiveAt {
	return () => {
		const opened = session.package.archive
		const current = opened?.get(name)

		if (opened === undefined || current === undefined) throw new Error(`${name} is not in the package`)

		return { entry: current, source: session.package.source, layout: opened.layout(current) }
	}
}

function eachMedia(shapes: readonly ShapeNode[], visit: (media: MediaRef) => void): void {
	eachShape(shapes, shape => {
		const media = shape.media ?? (shape.frame?.kind === "media" ? shape.frame.media : undefined)

		if (media !== undefined) visit(media)

		return false
	})
}

// Starts the index builds of the deflated media (up to PREPARE_AT_RENDER) a rendered slide plays, in the background
// lane: by the time the medium is played or a show reaches it, its stream is offered at once.
export function prepareSlideMedia(session: EngineSession, ref: SlideRef): void {
	const node = session.deck.nodes.get(ref)
	const parts = viewParts(session.deck)

	if (node === undefined || parts === undefined || session.package.archive === undefined) return

	const pptx = pptxParts(session.deck)
	let state: MediaState | undefined

	eachMedia(node.shapes, media => {
		const part = media.part

		if (part === undefined || insertedMediaId(part) !== undefined) return

		const key = partKey(part)
		const entry = parts.opc.entry(key)

		if (
			entry === undefined ||
			entry.method !== 8 ||
			entry.uncompressedSize > PREPARE_AT_RENDER ||
			entry.compressedSize > deflateBound(entry.uncompressedSize) ||
			(pptx !== undefined && !pptx.media.has(key))
		)
			return

		state ??= stateOf(session)

		if (!state.builds.has(key)) startIndex(session, state, key, part, archiveOf(session, entry.name))
	})
}

// The keys of the indexes to drop, used longest ago first (never `keep`), so that the windows of `builds` fit `budget`.
export function indexesOver(
	builds: ReadonlyMap<string, { readonly used: number; readonly index: { readonly windowBytes: number } | undefined }>,
	budget: number,
	keep: string
): string[] {
	let total = 0

	for (const build of builds.values()) total += build.index?.windowBytes ?? 0

	const out: string[] = []

	if (total <= budget) return out

	const built = [...builds].filter(([key, build]) => key !== keep && build.index !== undefined).sort(([, a], [, b]) => a.used - b.used)

	for (const [key, build] of built) {
		if (total <= budget) break

		total -= build.index?.windowBytes ?? 0
		out.push(key)
	}

	return out
}

// Builds a deflated medium's index in the background lane, sending its progress as "media" notices.
function startIndex(
	session: EngineSession,
	state: MediaState,
	key: string,
	// The part as the page named it (the notices name it so).
	part: string,
	archive: ArchiveAt
): void {
	const build: IndexBuild = { index: undefined, failed: false, progress: 0, used: ++clock }

	state.builds.set(key, build)

	const notice = (progress: number): void => {
		session.emit({ type: "notice", notice: { kind: "media", part, reason: "preparing", progress } })
	}

	session.schedule("background", async (slicing: Slicing, signal: CallSignal) => {
		try {
			const at = archive()
			const { dataOffset } = await at.layout
			const entry = at.entry
			const closed = sessionClosed(session)
			const index = await InflateIndex.build(
				{ size: entry.compressedSize, read: (offset, length) => mediaRead(at.source, dataOffset + offset, length) },
				{
					size: entry.uncompressedSize,
					crc32: entry.crc32,
					slicing,
					signal: {
						get aborted() {
							return signal.aborted || closed.aborted
						}
					},
					progress: produced => {
						const progress = entry.uncompressedSize === 0 ? 1 : produced / entry.uncompressedSize

						// A notice per tenth (the page keeps each one it was sent).
						if (progress < 1 && progress - build.progress < PROGRESS_STEP) return

						build.progress = progress

						if (progress < 1) notice(progress)
					}
				}
			)

			build.index = index
			build.progress = 1

			for (const over of indexesOver(state.builds, INDEX_BUDGET, key)) state.builds.delete(over)

			notice(1)
		} catch {
			// A damaged entry (or a session that closed) is no medium: the notice says it cannot be played.
			build.failed = true

			if (!sessionClosed(session).aborted) session.emit({ type: "notice", notice: { kind: "media", part, reason: "unplayable" } })
		}
	})
}

// Bytes of a device file or a drive file's range source, by offset.
function insertedReader(
	session: EngineSession,
	source: MediaInsertSource
): { readonly entry: Omit<InsertedEntry, "contentType">; readonly name: string; readonly type: string } | MediaRefusal {
	if (source.kind === "file") {
		const file: FileLike = source.file

		return {
			name: file.name,
			type: file.type,
			entry: {
				size: file.size,
				read: async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer())
			}
		}
	}

	if (session.rangeSource === undefined) return refusal("notImplemented")

	const bytes = session.rangeSource({ kind: "range", port: source.port, size: source.size, checked: source.checked })
	const closable = bytes as ByteSource & { close?: () => void }

	return {
		name: source.name,
		type: source.type,
		entry: {
			size: source.size,
			read: async (offset, length) => owned(await bytes.read(offset, length)),
			...(closable.close === undefined ? {} : { close: () => closable.close?.() })
		}
	}
}

// The bytes of an inserted medium as the save streams them: read again, checked against the size and CRC-32 they had
// at insert (a file changed since fails the save before its central directory is written).
function streamed(entry: Omit<InsertedEntry, "contentType">, crc: number): ByteChunks {
	return {
		length: entry.size,
		async *chunks(): AsyncIterable<Uint8Array> {
			let running = 0

			for (let at = 0; at < entry.size; at += READ_STEP) {
				const length = Math.min(READ_STEP, entry.size - at)
				const chunk = await entry.read(at, length)

				if (chunk.length !== length) throw new Error("the inserted medium changed since it was inserted")

				running = crc32(chunk, running)

				yield chunk
			}

			if (running !== crc) throw new Error("the inserted medium changed since it was inserted")
		}
	}
}

// Registers a medium for an insert: read once for its size, container and CRC-32 (in slices of the background lane).
export async function registerMedia(
	session: EngineSession,
	source: MediaInsertSource,
	slicing: Slicing,
	signal: CallSignal
): Promise<InsertedMedia | MediaRefusal> {
	const state = stateOf(session)
	const reader = insertedReader(session, source)

	if ("reason" in reader) return reader

	const { entry, name, type } = reader
	const fail = (reason: MediaRefusal["reason"]): MediaRefusal => {
		entry.close?.()

		return refusal(reason)
	}

	if (entry.size > MEDIA_LIMITS.mediaEntry) return fail("tooLarge")
	if (entry.size === 0) return fail("notMedia")

	let crc = 0
	let container: MediaContainer | undefined
	let sliceStart = slicing.now()

	try {
		for (let at = 0; at < entry.size; at += READ_STEP) {
			if (signal.aborted || sessionClosed(session).aborted) return fail("notFound")

			const length = Math.min(READ_STEP, entry.size - at)
			const chunk = await entry.read(at, length)

			if (chunk.length !== length) return fail("notFound")
			if (at === 0) {
				container = sniffMedia(chunk.subarray(0, SNIFF_BYTES))

				if (container === undefined) return fail("notMedia")
			}

			crc = crc32(chunk, crc)

			if (slicing.now() - sliceStart >= slicing.sliceMs) {
				await slicing.pause()
				sliceStart = slicing.now()
			}
		}
	} catch {
		return fail("notFound")
	}

	if (container === undefined) return fail("notMedia")

	const declaredAudio = /^audio\//iu.test(type)
	const kind: MediaRef["kind"] =
		declaredAudio || (!/^video\//iu.test(type) && CONTAINER_TYPES[container][0].startsWith("audio/")) ? "audio" : "video"
	const contentType = servedType(type, container, kind)
	const id = state.next++

	state.inserted.set(id, { ...entry, contentType })
	registerInsertedMedia(session.deck, id, { bytes: streamed(entry, crc), size: entry.size, crc32: crc, contentType, name })

	return { id, kind, contentType, size: entry.size, crc32: crc }
}

// What a written save added for inserted media and images (registry id → the entry's model name), committed with it.
export interface InsertedWrites {
	readonly media: ReadonlyMap<number, string>
	readonly images: ReadonlyMap<number, string>
}

// The inserted media and images among a save's added entries: a writer adds an inserted asset with the registry's own
// bytes object, so identity names the entry each was written to.
export function insertedWrites(deck: Deck, added: readonly PartChange[] | undefined): InsertedWrites | undefined {
	if (added === undefined || added.length === 0) return undefined

	const names = new Map<object, string>()

	for (const change of added) names.set(change.bytes, deck.format === "odp" ? change.name : `/${change.name}`)

	const media = insertedMediaAdded(deck, names)
	const images = insertedImagesAdded(deck, names)

	return media.size === 0 && images.size === 0 ? undefined : { media, images }
}

// The saved file is the session's base: each asset the save wrote is the part it was written to from then on. An
// image's bytes are freed (later saves relate its part), a medium's device file or drive port is let go of and its
// bytes are read from the saved package where anything still needs them (play, a conversion).
export function commitInsertedWrites(session: EngineSession, writes: InsertedWrites | undefined): void {
	if (writes === undefined) return

	commitInsertedImages(session.deck, writes.images, pictureSize)

	const state = states.get(session)

	commitInsertedMedia(session.deck, writes.media, (id, part, prior) => {
		const held = state?.inserted.get(id)

		held?.close?.()

		const entry = packageEntry(session, part, prior.size)

		if (state !== undefined) {
			if (held === undefined) state.inserted.delete(id)
			else state.inserted.set(id, { ...entry, contentType: held.contentType })
		}

		return { ...prior, bytes: streamed(entry, prior.crc32) }
	})
}

// A stored entry of the session's current package, read by offset (after a later rebase, of the package then).
function packageEntry(session: EngineSession, part: string, size: number): Omit<InsertedEntry, "contentType"> {
	const name = part.startsWith("/") ? part.slice(1) : part

	return {
		size,
		read: async (offset, length) => {
			const archive = session.package.archive
			const entry = archive?.get(name)

			if (archive === undefined || entry === undefined || entry.method !== 0)
				throw new Error(`${name} is not a stored entry of the package`)

			return owned(await mediaRead(session.package.source, (await archive.layout(entry)).dataOffset + offset, length))
		}
	}
}
