import { describe, expect, it } from "vitest"
import { bytesSource, crc32, memorySink, planZip, writeZip, ZipArchive, type PartChange } from "../core/opc/index"
import type { DeckChanges, PartChanges } from "../core/presentation/edit/apply"
import { PresentationError, type Deck, type SlideNode, type SourceRef } from "../core/presentation/model"
import { pptxSpliceWriter } from "../core/pptx/write/save"
import type { PptxSnapshot, SpliceWriter } from "../core/pptx/write/types"
import { SERVICES, type CallContext, type EngineSession, type OpenedPackage } from "../dom/presentation/engine"
import { pptxParts, openPptxCapability } from "../dom/presentation/engine/open/pptx"
import { editCapability } from "../dom/presentation/engine/edit"
import { pptxSaveSource, rebasePptx, SAVE_DEPENDENCIES } from "../dom/presentation/engine/save"
import type { PresentationEvent, SaveResult } from "../dom/presentation/protocol"
import {
	bindSaveHistory,
	commitSavedSession,
	deckTurn,
	rebasableSource,
	saveSession,
	type RemoteByteSource,
	type SaveDependencies,
	type SaveHistory
} from "../dom/presentation/save"
import { savePortAnnounced, savePortReader, type SavePortEnd } from "@filen/shared/savePort"
import { agileStreams, encryptedOfficeFile } from "./encryption/testing"
import { writeBigDeck, type BigDeckSpec } from "./fixtures/presentation/bigDeck"

// The save pipeline over a fake drive whose versioning is off (an upload deletes the version before it): the upload
// through the save port, the transport checks of the second gate before the upload may end, the hold on reads of the
// old file, and the rebase onto the saved one.

const SPEC: BigDeckSpec = {
	media: [
		{ kind: "png", bytes: 40_000, deflate: false },
		{ kind: "png", bytes: 40_000, deflate: true },
		{ kind: "mp4", bytes: 300_000, deflate: false, faststart: true },
		{ kind: "mp4", bytes: 300_000, deflate: true, faststart: false }
	],
	extraSlides: 3,
	seed: 21
}

async function deckBytes(): Promise<Uint8Array> {
	const sink = memorySink()

	await writeBigDeck(SPEC, sink)

	return sink.bytes().slice()
}

const CENTRAL_DIRECTORY = [0x50, 0x4b, 0x01, 0x02]

function contains(bytes: Uint8Array, pattern: readonly number[]): boolean {
	outer: for (let at = 0; at + pattern.length <= bytes.length; at++) {
		for (let k = 0; k < pattern.length; k++) if (bytes[at + k] !== pattern[k]) continue outer

		return true
	}

	return false
}

function join(parts: readonly Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
	let at = 0

	for (const part of parts) {
		out.set(part, at)
		at += part.length
	}

	return out
}

// A drive holding versions by uuid. Reads of a deleted version fail as a real one's would; checked reads checksum the
// stored bytes (the SDK worker's side) and `damage` flips a byte of what is sent after that.
class FakeDrive {
	readonly files = new Map<string, Uint8Array>()
	current: string
	reads = 0
	// Bytes the last upload received (whether or not it made a file).
	received: Uint8Array = new Uint8Array(0)
	uploads = 0
	damage: ((offset: number) => boolean) | undefined
	failFinalize = false
	// Copy passes the save began, the bytes their checked reads asked for, and sources closed through their host.
	passes = 0
	passBytes = 0
	closed = 0
	// The files whose sources were closed, in order.
	readonly closedFiles: string[] = []
	// A read of this file and length waits until the test lets it go.
	heldRead: { readonly uuid: string; readonly length: number; readonly until: Promise<void> } | undefined
	private inPass = false
	readonly versioning: boolean
	private next = 1

	constructor(bytes: Uint8Array, versioning: boolean) {
		this.versioning = versioning
		this.current = "v1"
		this.files.set("v1", bytes)
	}

	source(uuid: string): RemoteByteSource {
		const bytesOf = (): Uint8Array => {
			const bytes = this.files.get(uuid)

			if (bytes === undefined) throw new Error(`file ${uuid} is gone`)

			return bytes
		}

		return {
			size: bytesOf().length,
			read: async (offset, length) => {
				this.reads++

				if (this.heldRead?.uuid === uuid && this.heldRead.length === length) await this.heldRead.until

				return bytesOf().slice(offset, offset + length)
			},
			readChecked: (offset, length, crc) => {
				this.reads++

				if (this.inPass) this.passBytes += length

				try {
					const bytes = bytesOf().slice(offset, offset + length)
					const checked = crc32(bytes, crc)

					if (this.damage?.(offset) === true) bytes[0] = (bytes[0] ?? 0) ^ 0xff

					return Promise.resolve({ bytes, crc: checked })
				} catch (error) {
					return Promise.reject(error as Error)
				}
			},
			beginCopies: () => {
				this.passes++
				this.inPass = true
				this.passBytes = 0

				return {
					end: () => {
						this.inPass = false

						return this.passBytes
					}
				}
			},
			close: () => {
				this.closed++
				this.closedFiles.push(uuid)
			}
		}
	}

	// The SDK worker's upload over the save port: a new version once the stream ends, the old one deleted when
	// versioning is off; undefined when the stream aborted (no file).
	async upload(port: InstanceType<typeof MessageChannel>["port1"]): Promise<string | undefined> {
		const reader = savePortReader(port as unknown as SavePortEnd)
		const parts: Uint8Array[] = []

		try {
			for (let chunk = await reader.read(); chunk !== undefined; chunk = await reader.read()) parts.push(chunk)
		} catch {
			this.received = join(parts)

			return undefined
		}

		this.received = join(parts)

		if (this.failFinalize) {
			reader.settled(false)

			return undefined
		}

		const uuid = `v${String(++this.next)}`

		this.uploads++
		this.files.set(uuid, this.received)

		if (!this.versioning) this.files.delete(this.current)

		this.current = uuid
		reader.settled(true)

		return uuid
	}
}

// A history with a revision counter and a saved mark (the edit capability binds the real one).
class TestHistory implements SaveHistory {
	revision = 0
	saved = 0
	readonly abandoned: number[] = []
	// What changed against the saved state (the edit capability's changes.ts recomputes it).
	parts: ReadonlyMap<string, PartChanges> = new Map()

	get dirty(): boolean {
		return this.revision !== this.saved
	}

	edit(): void {
		this.revision++
	}

	changes(): DeckChanges {
		return { empty: !this.dirty, parts: this.dirty ? this.parts : new Map(), presentation: new Set() }
	}

	savePoint() {
		return { revision: this.revision }
	}

	commit(point: { readonly revision: number }): void {
		this.saved = point.revision
	}

	abandon(point: { readonly revision: number }): void {
		this.abandoned.push(point.revision)
	}
}

// A splice writer standing in for the pptx one: the parts `edits()` holds at snapshot time replace theirs; every
// other entry is a raw copy from the session's archive.
function testWriter(edits: () => ReadonlyMap<string, Uint8Array | PartChange>): SpliceWriter & { snapshots: number } {
	let archive: ZipArchive | undefined
	const writer = {
		snapshots: 0,
		snapshot(input: Parameters<SpliceWriter["snapshot"]>[0]): Promise<PptxSnapshot> {
			writer.snapshots++
			archive = input.source.archive

			const replace = [...edits()].map(([name, edit]) => (edit instanceof Uint8Array ? { name, bytes: edit } : edit))

			return Promise.resolve({ revision: input.revision, changes: { replace }, copies: archive.entries.length - replace.length })
		},
		async write(snapshot: PptxSnapshot, sink: Parameters<SpliceWriter["write"]>[1], options: Parameters<SpliceWriter["write"]>[2]) {
			if (archive === undefined) throw new Error("no snapshot")

			const report = await writeZip(
				planZip(archive, snapshot.changes),
				archive,
				sink,
				options.slicing === undefined ? {} : { slicing: options.slicing }
			)

			return { kind: "written" as const, report, revision: snapshot.revision }
		}
	}

	return writer
}

interface Harness {
	readonly drive: FakeDrive
	readonly session: EngineSession
	readonly context: CallContext
	readonly history: TestHistory
	readonly events: PresentationEvent[]
	readonly opened: OpenedPackage
	save(dependencies: SaveDependencies): Promise<{ readonly result: SaveResult; readonly uuid: string | undefined }>
	commit(
		dependencies: SaveDependencies,
		saved: { readonly result: SaveResult; readonly uuid: string | undefined }
	): Promise<{ readonly dirty: boolean }>
}

async function harness(
	options: { readonly versioning?: boolean; readonly bytes?: Uint8Array; readonly password?: string } = {}
): Promise<Harness> {
	const drive = new FakeDrive(options.bytes ?? (await deckBytes()), options.versioning ?? false)
	const source = rebasableSource(drive.source("v1"))
	const outcome = await openPptxCapability.open({
		source,
		sourceKind: options.password === undefined ? "range" : "bytes",
		options: { format: "pptx", fileName: "deck.pptx" },
		...(options.password === undefined ? {} : { password: options.password })
	})

	if (outcome.kind !== "opened") throw new Error(`open: ${outcome.kind}`)

	const events: PresentationEvent[] = []
	const history = new TestHistory()
	const session: EngineSession = {
		s: 1,
		deck: outcome.deck,
		package: outcome.package,
		options: { format: "pptx", fileName: "deck.pptx" },
		services: SERVICES,
		rangeSource: spec => drive.source((spec.port as unknown as { uuid: string }).uuid),
		schedule: () => undefined,
		emit: event => {
			events.push(event)
		},
		onClose: () => undefined
	}
	const context: CallContext = {
		session,
		signal: { aborted: false, onAbort: () => undefined },
		lane: "background",
		slicing: { pause: () => Promise.resolve(), sliceMs: 8, now: () => Date.now() }
	}

	bindSaveHistory(outcome.deck, history)

	return {
		drive,
		session,
		context,
		history,
		events,
		opened: outcome.package,
		async save(dependencies) {
			const { port1, port2 } = new MessageChannel()
			const uploading = drive.upload(port2)
			const result = await saveSession(context, { reason: "user", port: port1 as unknown as SavePortEnd }, dependencies)

			return { result, uuid: await uploading }
		},
		commit(dependencies, saved) {
			if (saved.result.kind !== "written" || saved.uuid === undefined) throw new Error("nothing to commit")

			const port = { uuid: saved.uuid, postMessage: () => undefined, close: () => undefined }

			return commitSavedSession(
				context,
				{
					file: { uuid: saved.uuid, name: "deck.pptx" },
					port,
					size: drive.files.get(saved.uuid)?.length ?? 0,
					revision: saved.result.revision
				},
				dependencies
			)
		}
	}
}

const SLIDE1 = "ppt/slides/slide1.xml"

// Slide 1 as an edit writes it: a new shape (id 9) before the title, and the title's text changed, so every node of
// the title moves.
async function editedSlide1(h: Harness, text: string): Promise<Uint8Array> {
	const archive = h.session.package.archive

	if (archive === undefined) throw new Error("no archive")

	const entry = archive.get(SLIDE1)

	if (entry === undefined) throw new Error("no slide 1")

	const xml = new TextDecoder().decode(await archive.read(entry))
	const inserted =
		'<p:sp><p:nvSpPr><p:cNvPr id="9" name="Inserted"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>New</a:t></a:r></a:p></p:txBody></p:sp>'

	return new TextEncoder().encode(xml.replace(/(<p:grpSpPr\/>)/u, `$1${inserted}`).replace(/<a:t>Slide 1<\/a:t>/u, `<a:t>${text}</a:t>`))
}

function dependencies(writer: SpliceWriter, inMemoryLimit?: number): SaveDependencies {
	return { savers: { pptx: { writer } }, rebasers: { pptx: rebasePptx }, ...(inMemoryLimit === undefined ? {} : { inMemoryLimit }) }
}

// Every pptx src in the model.
function sources(deck: Deck): SourceRef[] {
	const out: SourceRef[] = []
	const seen = new Set<object>()
	const visit = (value: unknown): void => {
		if (typeof value !== "object" || value === null || ArrayBuffer.isView(value) || seen.has(value)) return

		seen.add(value)

		if (Array.isArray(value)) value.forEach(visit)
		else if (value instanceof Map) [...value.values()].forEach(visit)
		else
			for (const [key, field] of Object.entries(value)) {
				if (key === "src" && typeof field === "object" && field !== null && "epoch" in field) out.push(field as SourceRef)
				else visit(field)
			}
	}

	visit(deck)

	return out
}

describe("presentation save", () => {
	it("uploads nothing for a deck without changes, or one whose edits were all undone", async () => {
		const h = await harness()
		const writer = testWriter(() => new Map())

		expect((await h.save(dependencies(writer))).result).toEqual({ kind: "unchanged" })

		h.history.edit()
		h.history.saved = h.history.revision

		expect(await h.save(dependencies(writer))).toEqual({ result: { kind: "unchanged" }, uuid: undefined })
		expect(writer.snapshots).toBe(0)
		expect(h.drive.uploads).toBe(0)
		expect(h.drive.files.has("v1")).toBe(true)
	})

	it("refuses a gated deck without uploading", async () => {
		const h = await harness()

		h.session.deck.gate.push("signed")
		h.history.edit()

		expect(await h.save(dependencies(testWriter(() => new Map())))).toEqual({
			result: { kind: "refused", reason: "viewOnly" },
			uuid: undefined
		})
	})

	for (const path of ["in memory", "streamed"] as const) {
		it(`saves ${path} through the port: the drive's new version is the written package, copies checked`, async () => {
			const h = await harness()
			const slide = await editedSlide1(h, "Saved")
			const deps = dependencies(
				testWriter(() => new Map([[SLIDE1, slide]])),
				path === "streamed" ? 1024 : undefined
			)

			h.history.edit()

			const saved = await h.save(deps)

			expect(saved.result).toMatchObject({ kind: "written", revision: 1 })
			expect(saved.uuid).toBe("v2")

			const archive = await ZipArchive.open(bytesSource(h.drive.files.get("v2") ?? new Uint8Array(0)))
			const original = h.opened.archive

			expect(archive.entries.map(entry => entry.name)).toEqual(original?.entries.map(entry => entry.name))
			expect(new TextDecoder().decode(await archive.read(archive.get(SLIDE1) ?? archive.entries[0]!))).toContain("Saved")

			// Every copy came through a checked read, and what the save reports is what the network carried.
			const written = saved.result as Extract<SaveResult, { kind: "written" }> & {
				transfer: { uploaded: number; downloaded: number }
			}

			expect(written.bytes).toBe(h.drive.received.length)
			expect(written.transfer.uploaded).toBe(h.drive.received.length)
			expect(written.transfer.downloaded).toBeGreaterThan(h.drive.received.length - 4096)
		})
	}

	it("keeps the deck readable when the upload fails after the last byte", async () => {
		const h = await harness()

		const slide = await editedSlide1(h, "X")

		h.drive.failFinalize = true
		h.history.edit()

		const saved = await h.save(dependencies(testWriter(() => new Map([[SLIDE1, slide]]))))

		expect(saved.result).toEqual({ kind: "refused", reason: "failed" })
		// No hold left behind: the old file reads on.
		expect((await h.session.package.source.read(0, 4)).length).toBe(4)
		expect(h.history.dirty).toBe(true)
	})

	it("holds reads of the old file from the end of the upload; after the rebase a copied entry reads the saved file and a rewritten one is stale", async () => {
		const h = await harness()
		const deps = dependencies(
			testWriter(() => new Map([[SLIDE1, new TextEncoder().encode("<p:sld/>")]])),
			1024
		)
		const old = h.session.package.source
		const archive = h.opened.archive!
		const copied = archive.entries.find(entry => entry.name !== SLIDE1 && entry.compressedSize > 64)!
		const rewritten = archive.get(SLIDE1)!
		const expected = await old.read(copied.localHeaderOffset, 64)

		h.history.edit()

		const saved = await h.save(deps)
		let settled = false
		const late = old.read(copied.localHeaderOffset, 64).then(bytes => {
			settled = true

			return bytes
		})
		const stale = old.read(rewritten.localHeaderOffset, 4)

		stale.catch(() => undefined)
		await new Promise(resolve => setTimeout(resolve, 20))
		expect(settled).toBe(false)

		await h.commit(deps, saved)

		// The old version is gone: the bytes come from the saved file, where the entry moved.
		expect(h.drive.files.has("v1")).toBe(false)
		expect(await late).toEqual(expected)
		expect(await old.read(copied.localHeaderOffset + 1, 63)).toEqual(expected.subarray(1))
		await expect(stale).rejects.toEqual(new PresentationError("stale", "the deck was rebased onto its saved file"))
	})

	it("reports the bytes the source downloaded for the save's copies, read in one copy pass", async () => {
		const h = await harness()

		h.history.edit()

		const saved = await h.save(dependencies(testWriter(() => new Map([[SLIDE1, new TextEncoder().encode("<p:sld/>")]]))))

		expect(h.drive.passes).toBe(1)
		expect(saved.result).toMatchObject({ kind: "written", transfer: { downloaded: h.drive.passBytes } })
		expect(h.drive.passBytes).toBeGreaterThan(0)
	})

	it("sends the kept package again when a failed upload is retried at the same revision, reading nothing from the source", async () => {
		const h = await harness()
		const writer = testWriter(() => new Map([[SLIDE1, new TextEncoder().encode("<p:sld/>")]]))
		const deps = dependencies(writer)

		h.drive.failFinalize = true
		h.history.edit()

		expect((await h.save(deps)).result).toEqual({ kind: "refused", reason: "failed" })

		const first = h.drive.received
		const reads = h.drive.reads

		h.drive.failFinalize = false

		const retried = await h.save(deps)

		expect(retried.result).toMatchObject({ kind: "written", revision: 1, transfer: { downloaded: 0 } })
		expect(h.drive.reads).toBe(reads)
		expect(writer.snapshots).toBe(1)
		expect(h.drive.files.get(retried.uuid!)).toEqual(first)
		expect(await h.commit(deps, retried)).toEqual({ dirty: false })

		// An edit since the failure saves anew.
		h.drive.failFinalize = true
		h.history.edit()
		await h.save(deps)
		h.drive.failFinalize = false
		h.history.edit()
		expect((await h.save(deps)).result).toMatchObject({ kind: "written", revision: 3 })
		expect(writer.snapshots).toBe(3)
	})

	it("closes the saved file's port through its host when the session rebases from the zip it kept", async () => {
		const h = await harness()
		const deps = dependencies(testWriter(() => new Map([[SLIDE1, new TextEncoder().encode("<p:sld/>")]])))

		h.history.edit()

		const saved = await h.save(deps)

		await h.commit(deps, saved)
		// The saved file's port at once, then the old file's, which the session no longer reads.
		expect(h.drive.closedFiles).toEqual(["v2", "v1"])
	})

	it("a dirty deck with nothing net to write answers unchanged and reads clean from then on", async () => {
		const h = await harness()
		const deps = dependencies(testWriter(() => new Map()))

		h.history.edit()
		// Dirty keys that name no part to write (the history's changes are empty).
		h.history.changes = () => ({ empty: true, parts: new Map(), presentation: new Set() })
		expect((await h.save(deps)).result).toEqual({ kind: "unchanged" })
		expect(h.history.dirty).toBe(false)
		expect(h.events.at(-1)).toMatchObject({ type: "changed", dirty: false, slides: [] })
	})

	it("a snapshot the writer refuses stale (a part the session held is gone) answers failed: the file did not change", async () => {
		const h = await harness()
		const deps = dependencies({
			snapshot: () => Promise.resolve({ kind: "refused", reason: "stale", detail: "the diagram part raw:1 is no longer held" }),
			write: () => Promise.resolve({ kind: "unchanged" })
		})

		h.history.edit()
		expect((await h.save(deps)).result).toEqual({ kind: "refused", reason: "failed" })
		expect(h.history.dirty).toBe(true)
	})

	it("a snapshot the writer finds nothing to write in commits its state as saved", async () => {
		const h = await harness()
		const writer = testWriter(() => new Map([[SLIDE1, new TextEncoder().encode("<p:sld/>")]]))
		const deps = dependencies({ snapshot: input => writer.snapshot(input), write: () => Promise.resolve({ kind: "unchanged" }) })

		h.history.edit()
		expect((await h.save(deps)).result).toEqual({ kind: "unchanged" })
		expect(h.history.dirty).toBe(false)
		expect(h.history.abandoned).toEqual([])
		expect(h.events.at(-1)).toMatchObject({ type: "changed", dirty: false })
	})

	it("closes the old file's range port once the session reads the saved file", async () => {
		const h = await harness({ versioning: true })
		const deps = dependencies(
			testWriter(() => new Map([[SLIDE1, new TextEncoder().encode("<p:sld/>")]])),
			1024
		)

		h.history.edit()

		const saved = await h.save(deps)

		expect(await h.commit(deps, saved)).toEqual({ dirty: false })
		expect(h.drive.closedFiles).toEqual(["v1"])
	})

	it("closes the old file's range port only after a read of it in flight ends", async () => {
		const h = await harness({ versioning: true })
		const deps = dependencies(
			testWriter(() => new Map([[SLIDE1, new TextEncoder().encode("<p:sld/>")]])),
			1024
		)

		const gate = Promise.withResolvers<undefined>()

		h.drive.heldRead = { uuid: "v1", length: 3, until: gate.promise }

		// A read of the old file (a slide's media) started before the save, still running when it commits.
		const reading = h.session.package.source.read(0, 3)

		h.history.edit()
		await h.commit(deps, await h.save(deps))
		expect(h.drive.closedFiles).toEqual([])
		gate.resolve(undefined)
		expect((await reading).length).toBe(3)
		expect(h.drive.closedFiles).toEqual(["v1"])
	})

	for (const path of ["in memory", "streamed"] as const) {
		it(`rebases ${path} with versioning off: unparsed slides, media and a second save read the new file`, async () => {
			const h = await harness({ versioning: false })
			const parts = pptxParts(h.session.deck)

			if (parts === undefined) throw new Error("no parts")

			const first = h.session.deck.slides[0]!
			const node = await parts.slide(first)
			const title = node.shapes.find(shape => shape.id === 2)!
			let text = "Saved"
			const slide = await editedSlide1(h, "Saved")
			const deps = dependencies(
				testWriter(() => new Map([[SLIDE1, new TextEncoder().encode(new TextDecoder().decode(slide).replace("Saved", text))]])),
				path === "streamed" ? 1024 : undefined
			)

			h.history.edit()

			const saved = await h.save(deps)

			expect([...h.drive.files.keys()]).toEqual(["v2"])
			expect(await h.commit(deps, saved)).toEqual({ dirty: false })
			expect(h.session.package.source.size).toBe(h.drive.files.get("v2")?.length)

			// The title's refs moved into the new document, past the inserted shape; everything else is on the new epoch.
			const document = parts.document(node.part)!
			const titleSrc = title.src as Extract<SourceRef, { format: "pptx" }>

			expect(titleSrc.epoch).toBe(1)
			expect(document.name(titleSrc.node)).toBe("p:sp")
			expect(document.textContent(titleSrc.node)).toBe("Saved")
			expect(sources(h.session.deck).every(src => src.epoch === 1)).toBe(true)

			// A slide not parsed before the save parses from the saved file with the new epoch.
			const unparsed = h.session.deck.slides.find(ref => !h.session.deck.nodes.has(ref))!
			const later: SlideNode = await parts.slide(unparsed)

			expect(sources({ nodes: new Map([[unparsed, later]]) } as unknown as Deck).every(src => src.epoch === 1)).toBe(true)

			// Media (a range of a stored entry) reads from the new file.
			const media = h.session.package.archive!.entries.find(entry => entry.name.endsWith(".mp4") && entry.method === 0)!

			expect((await h.session.package.archive!.raw(media)).length).toBe(media.compressedSize)

			// Edit again (an edit made while the second save streams stays dirty) and save: copies come from v2.
			text = "Again"
			h.history.edit()

			const second = await h.save(deps)

			expect(second.result).toMatchObject({ kind: "written", revision: 2 })
			expect([...h.drive.files.keys()]).toEqual(["v3"])
			expect(await h.commit(deps, second)).toEqual({ dirty: false })

			const again = title.src as Extract<SourceRef, { format: "pptx" }>

			expect(again.epoch).toBe(2)
			expect(parts.document(node.part)).not.toBe(document)
			expect(parts.document(node.part)!.textContent(again.node)).toBe("Again")
		})
	}

	it("takes the snapshot between commands: an edit made while the upload streams stays dirty for the next save", async () => {
		const h = await harness()
		let text = "R1"
		const slide = await editedSlide1(h, "PLACEHOLDER")
		const deps = dependencies(
			testWriter(() => new Map([[SLIDE1, new TextEncoder().encode(new TextDecoder().decode(slide).replace("PLACEHOLDER", text))]]))
		)

		h.history.edit()

		const { port1, port2 } = new MessageChannel()
		// The upload reads one chunk, then the user types (a command in the deck's turn) before the rest is read.
		const uploading = h.drive.upload(port2)
		const saving = saveSession(h.context, { reason: "auto", port: port1 as unknown as SavePortEnd }, deps)

		await deckTurn(h.session.deck, () => {
			text = "R2"
			h.history.edit()

			return Promise.resolve()
		})

		const result = await saving
		const uuid = await uploading

		expect(result).toMatchObject({ kind: "written", revision: 1 })
		expect(await h.commit(deps, { result, uuid })).toEqual({ dirty: true })

		const stored = await ZipArchive.open(bytesSource(h.drive.files.get(uuid!)!))

		expect(new TextDecoder().decode(await stored.read(stored.get(SLIDE1)!))).toContain("R1")

		const next = await h.save(deps)

		expect(next.result).toMatchObject({ kind: "written", revision: 2 })

		const nextStored = await ZipArchive.open(bytesSource(h.drive.files.get(next.uuid!)!))

		expect(new TextDecoder().decode(await nextStored.read(nextStored.get(SLIDE1)!))).toContain("R2")
	})
})

// The same pipeline over the pptx splice writer (its second gate checks the copies and new entries) with a moved
// shape: the snapshot serializes slide 1, everything else is copied.
describe("presentation save with the pptx writer", () => {
	async function moved(h: Harness, x: number): Promise<SlideNode> {
		const parts = pptxParts(h.session.deck)

		if (parts === undefined) throw new Error("no parts")

		const node = await parts.slide(h.session.deck.slides[0]!)
		const title = node.shapes.find(shape => shape.id === 2)!

		title.xfrm = { x, y: 365_125, cx: 10_515_600, cy: 1_325_563, rot: 0, flipH: false, flipV: false }
		h.history.parts = new Map([[node.part, { change: "changed", shapes: new Map([[2, { kind: "xfrm" }]]) }]])
		h.history.edit()

		return node
	}

	const writer = (inMemoryLimit?: number): SaveDependencies => ({
		savers: { pptx: { writer: pptxSpliceWriter, source: pptxSaveSource } },
		rebasers: { pptx: rebasePptx },
		...(inMemoryLimit === undefined ? {} : { inMemoryLimit })
	})

	async function stored(h: Harness, uuid: string): Promise<string> {
		const archive = await ZipArchive.open(bytesSource(h.drive.files.get(uuid)!))

		return new TextDecoder().decode(await archive.read(archive.get(SLIDE1)!))
	}

	for (const path of ["in memory", "streamed"] as const) {
		it(`writes the moved shape ${path}, copies every other part, and rebases onto the saved file`, async () => {
			const h = await harness()
			const node = await moved(h, 1_234_567)
			const deps = writer(path === "streamed" ? 1024 : undefined)
			const saved = await h.save(deps)

			expect(saved.result).toMatchObject({ kind: "written", revision: 1 })
			expect(await stored(h, saved.uuid!)).toContain('x="1234567"')
			expect(await h.commit(deps, saved)).toEqual({ dirty: false })

			// The old version is gone; a slide not parsed before, and a stored medium, read from the saved file.
			expect(h.drive.files.has("v1")).toBe(false)

			const unparsed = h.session.deck.slides.find(ref => !h.session.deck.nodes.has(ref))!

			expect((await pptxParts(h.session.deck)!.slide(unparsed)).src).toMatchObject({ epoch: 1 })

			const media = h.session.package.archive!.entries.find(entry => entry.name.endsWith(".mp4") && entry.method === 0)!

			expect((await h.session.package.archive!.raw(media)).length).toBe(media.compressedSize)

			// Edit again on the rebased deck and save: the copies now come from the saved file.
			await moved(h, 2_345_678)

			const again = await h.save(deps)

			expect(again.result).toMatchObject({ kind: "written", revision: 2 })
			expect(await stored(h, again.uuid!)).toContain('x="2345678"')
			expect([...h.drive.files.keys()]).toEqual([again.uuid])
			expect(node.shapes.find(shape => shape.id === 2)?.src).toMatchObject({ epoch: 1 })
		})
	}

	it("typing during a throttled save: the saved file has revision R exactly, and the next save carries the later ops", async () => {
		const h = await harness()

		await moved(h, 1_111_111)

		const deps = writer(1024)
		const { port1, port2 } = new MessageChannel()
		const typed = Promise.withResolvers<undefined>()
		// A slow upload: it reads nothing until the user has typed.
		const uploading = typed.promise.then(() => h.drive.upload(port2))
		const saving = saveSession(h.context, { reason: "auto", port: port1 as unknown as SavePortEnd }, deps)

		// The command waits for the snapshot (the deck's turn), then runs while the upload is still to come.
		await deckTurn(h.session.deck, () => moved(h, 2_222_222))
		typed.resolve(undefined)

		const result = await saving
		const uuid = await uploading

		expect(result).toMatchObject({ kind: "written", revision: 1 })
		expect(await stored(h, uuid!)).toContain('x="1111111"')
		expect(await h.commit(deps, { result, uuid })).toEqual({ dirty: true })

		const next = await h.save(deps)

		expect(next.result).toMatchObject({ kind: "written", revision: 2 })
		expect(await stored(h, next.uuid!)).toContain('x="2222222"')
	})

	it("errors the stream before the central directory when a copied range arrives damaged: no new version", async () => {
		const h = await harness()

		await moved(h, 1_234_567)
		h.drive.damage = offset => offset > 0

		const saved = await h.save(writer(1024))

		expect(saved.uuid).toBeUndefined()
		expect(saved.result).toMatchObject({ kind: "refused" })
		expect(contains(h.drive.received, CENTRAL_DIRECTORY)).toBe(false)
		expect([...h.drive.files.keys()]).toEqual(["v1"])
		expect(h.history.abandoned).toEqual([1])
		expect(h.history.dirty).toBe(true)
	})
})

// Through the edit capability: real ops, the deck's history bound for the save, the save capability end to end.
describe("presentation save of edits", () => {
	async function editHarness(): Promise<Harness & { readonly move: (x: number) => Promise<unknown> }> {
		const h = await harness()

		// The edit capability binds its own history on the first command.
		const slide = h.session.deck.slides[0]!

		await pptxParts(h.session.deck)!.slide(slide)

		return {
			...h,
			move: x =>
				editCapability.command(h.context, {
					family: "shape",
					kind: "setXfrm",
					target: { slide, id: 2 },
					xfrm: { x, y: 365_125, cx: 10_515_600, cy: 1_325_563, rot: 0, flipH: false, flipV: false }
				})
		}
	}

	async function stored(h: Harness, uuid: string): Promise<string> {
		const archive = await ZipArchive.open(bytesSource(h.drive.files.get(uuid)!))

		return new TextDecoder().decode(await archive.read(archive.get(SLIDE1)!))
	}

	it("tells the page before any upload whether the save writes, and that the deck is clean once the save is committed", async () => {
		const h = await editHarness()
		const idle = new MessageChannel()
		const idleAnnounced = savePortAnnounced(idle.port2 as unknown as SavePortEnd)

		expect(await saveSession(h.context, { reason: "user", port: idle.port1 as unknown as SavePortEnd }, SAVE_DEPENDENCIES)).toEqual({
			kind: "unchanged"
		})
		expect(await idleAnnounced).toBe(false)

		await h.move(3_000_000)

		const { port1, port2 } = new MessageChannel()
		const announced = savePortAnnounced(port2 as unknown as SavePortEnd)
		const saving = saveSession(h.context, { reason: "user", port: port1 as unknown as SavePortEnd }, SAVE_DEPENDENCIES)

		expect(await announced).toBe(true)

		const uuid = await h.drive.upload(port2)
		const result = await saving

		expect(result).toMatchObject({ kind: "written" })
		expect(await h.commit(SAVE_DEPENDENCIES, { result, uuid })).toEqual({ dirty: false })
		expect(h.events.at(-1)).toEqual({
			type: "changed",
			revision: expect.any(Number) as number,
			dirty: false,
			dirtyBytes: 0,
			slides: []
		})
	})

	it("saves an op, then nothing once it is undone, and rebases with versioning off", async () => {
		const h = await editHarness()

		expect(await h.move(3_000_000)).toMatchObject({ ok: true, dirty: true })

		const saved = await h.save(SAVE_DEPENDENCIES)

		expect(saved.result).toMatchObject({ kind: "written" })
		expect(await stored(h, saved.uuid!)).toContain('x="3000000"')
		expect(await h.commit(SAVE_DEPENDENCIES, saved)).toEqual({ dirty: false })
		expect([...h.drive.files.keys()]).toEqual([saved.uuid])

		expect(await editCapability.undo(h.context)).toMatchObject({ ok: true, dirty: true })
		expect(await editCapability.redo(h.context)).toMatchObject({ ok: true, dirty: false })
		expect(await h.save(SAVE_DEPENDENCIES)).toEqual({ result: { kind: "unchanged" }, uuid: undefined })
	})

	it("parses a slide asked for between the upload's end and the rebase from the saved file, not as damage", async () => {
		const h = await editHarness()

		await h.move(3_000_000)

		const saved = await h.save(SAVE_DEPENDENCIES)
		const unparsed = h.session.deck.slides.find(ref => !h.session.deck.nodes.has(ref))!
		const late = pptxParts(h.session.deck)!.slide(unparsed)

		late.catch(() => undefined)
		expect(await h.commit(SAVE_DEPENDENCIES, saved)).toEqual({ dirty: false })
		expect(h.drive.files.has("v1")).toBe(false)
		expect((await late).ref).toBe(unparsed)
		expect(h.session.deck.gate).toEqual([])
	})

	it("restores a shape deleted and undone after a rebase from the bytes its inverse holds, through gate 2", async () => {
		const h = await editHarness()
		const slide = h.session.deck.slides[0]!
		const element = (xml: string): string => /<p:pic>.*?<\/p:pic>/su.exec(xml)?.[0] ?? ""

		await h.move(3_000_000)

		const first = await h.save(SAVE_DEPENDENCIES)

		expect(first.result).toMatchObject({ kind: "written" })
		expect(await h.commit(SAVE_DEPENDENCIES, first)).toEqual({ dirty: false })

		const picture = element(await stored(h, first.uuid!))

		expect(picture).not.toBe("")
		expect(await editCapability.command(h.context, { family: "shape", kind: "delete", slide, shapes: [3] })).toMatchObject({ ok: true })
		expect(await editCapability.undo(h.context)).toMatchObject({ ok: true })
		await h.move(4_000_000)

		const second = await h.save(SAVE_DEPENDENCIES)

		expect(second.result).toMatchObject({ kind: "written" })

		const xml = await stored(h, second.uuid!)

		expect(xml).toContain('x="4000000"')
		expect(element(xml)).toBe(picture)
	})

	it("typing during a throttled save: the saved file has revision R exactly, and the next save carries the later ops", async () => {
		const h = await editHarness()

		await h.move(1_111_111)

		const { port1, port2 } = new MessageChannel()
		const typed = Promise.withResolvers<undefined>()
		const uploading = typed.promise.then(() => h.drive.upload(port2))
		const saving = saveSession(h.context, { reason: "auto", port: port1 as unknown as SavePortEnd }, SAVE_DEPENDENCIES)
		const typing = h.move(2_222_222)

		typed.resolve(undefined)

		const [result, uuid] = await Promise.all([saving, uploading])

		expect(await typing).toMatchObject({ ok: true })
		expect(await stored(h, uuid!)).toContain('x="1111111"')
		expect(await h.commit(SAVE_DEPENDENCIES, { result, uuid })).toEqual({ dirty: true })

		const next = await h.save(SAVE_DEPENDENCIES)

		expect(await stored(h, next.uuid!)).toContain('x="2222222"')
		expect(await h.commit(SAVE_DEPENDENCIES, next)).toEqual({ dirty: false })
	})
})

describe("presentation save of an encrypted deck", () => {
	it("seals the save under the deck's key, and rebases onto the zip it sealed", async () => {
		const plain = await deckBytes()
		const h = await harness({ bytes: await encryptedOfficeFile(agileStreams(plain, "filen")), password: "filen" })
		const parts = pptxParts(h.session.deck)!
		const node = await parts.slide(h.session.deck.slides[0]!)
		const title = node.shapes.find(shape => shape.id === 2)!

		title.xfrm = { x: 7_654_321, y: 365_125, cx: 10_515_600, cy: 1_325_563, rot: 0, flipH: false, flipV: false }
		h.history.parts = new Map([[node.part, { change: "changed", shapes: new Map([[2, { kind: "xfrm" }]]) }]])
		h.history.edit()

		const saved = await h.save(SAVE_DEPENDENCIES)

		expect(saved.result).toMatchObject({ kind: "written", revision: 1 })

		const file = h.drive.files.get(saved.uuid!)!
		const reopened = await openPptxCapability.open({
			source: bytesSource(file),
			sourceKind: "bytes",
			options: { format: "pptx", fileName: "deck.pptx" },
			password: "filen"
		})

		if (reopened.kind !== "opened") throw new Error(reopened.kind)

		const zip = reopened.package.archive!

		expect(new TextDecoder().decode(await zip.read(zip.get(SLIDE1)!))).toContain('x="7654321"')
		reopened.package.release?.()

		// The session reads the zip it sealed, not the sealed file.
		expect(await h.commit(SAVE_DEPENDENCIES, saved)).toEqual({ dirty: false })
		expect(h.session.package.source.size).toBeLessThan(file.length)
		expect(h.session.deck.protection.encrypted).toBeDefined()
	})
})
