import { MessageChannel } from "node:worker_threads"
import { savePortReader, type SavePortEnd } from "@filen/shared/savePort"
import { bytesSource } from "../core/opc/index"
import type { DeckChanges, PartChanges } from "../core/presentation/edit/apply"
import type { Deck, SlideNode } from "../core/presentation/model"
import type { Slicing } from "../core/slicing"
import { SERVICES, type EngineSession } from "../dom/presentation/engine"
import { openPptxCapability, pptxParts } from "../dom/presentation/engine/open/pptx"
import { SAVE_DEPENDENCIES } from "../dom/presentation/engine/save"
import type { SaveResult } from "../dom/presentation/protocol"
import { bindSaveHistory, saveSession, type SaveHistory } from "../dom/presentation/save"

// An encrypted deck opened with its password as the presentation engine opens it, saved through saveSession with the
// shipped dependencies (the sealer is the session's PackageSealer): what a user's save of an encrypted deck runs. The
// upload side reads the save port to its end and makes the file.

// A history with a revision counter and a saved mark (the edit capability binds the real one).
class SealedHistory implements SaveHistory {
	revision = 0
	saved = 0
	parts: ReadonlyMap<string, PartChanges> = new Map()

	get dirty(): boolean {
		return this.revision !== this.saved
	}

	changes(): DeckChanges {
		return { empty: !this.dirty, parts: this.dirty ? this.parts : new Map(), presentation: new Set() }
	}

	savePoint(): { readonly revision: number } {
		return { revision: this.revision }
	}

	commit(point: { readonly revision: number }): void {
		this.saved = point.revision
	}

	abandon(): void {}
}

export interface SealedSave {
	readonly result: SaveResult
	// What the upload received (empty when the save's `chunk` took it); undefined when no file was made.
	readonly file: Uint8Array | undefined
}

export interface SealedSession {
	readonly deck: Deck
	// The size of the decrypted package the session reads.
	readonly packageBytes: number
	// The slide's parsed node, as the edit capability reads it.
	slide(index: number): Promise<SlideNode>
	// Marks one shape's frame as changed since the saved state (the shape itself is moved by the caller).
	moved(node: SlideNode, shapeId: number): void
	// One save; `chunk` sees each chunk the upload reads, which the upload keeps only without it.
	save(options?: { readonly slicing?: Slicing; readonly chunk?: (bytes: Uint8Array) => void }): Promise<SealedSave>
	close(): void
}

const SLICING: Slicing = { pause: () => Promise.resolve(), sliceMs: 8, now: () => Date.now() }

export async function openSealedSession(file: Uint8Array, password: string): Promise<SealedSession> {
	const outcome = await openPptxCapability.open({
		source: bytesSource(file),
		sourceKind: "bytes",
		options: { format: "pptx", fileName: "deck.pptx" },
		password
	})

	if (outcome.kind !== "opened") throw new Error(`open: ${outcome.kind}`)

	const history = new SealedHistory()
	const session: EngineSession = {
		s: 1,
		deck: outcome.deck,
		package: outcome.package,
		options: { format: "pptx", fileName: "deck.pptx" },
		services: SERVICES,
		rangeSource: () => {
			throw new Error("no remote source")
		},
		schedule: () => undefined,
		emit: () => undefined,
		onClose: () => undefined
	}
	const parts = pptxParts(outcome.deck)

	if (parts === undefined) throw new Error("no part map")

	bindSaveHistory(outcome.deck, history)

	return {
		deck: outcome.deck,
		packageBytes: outcome.package.source.size,
		slide: async index => {
			const ref = session.deck.slides[index]

			if (ref === undefined) throw new Error(`no slide ${String(index)}`)

			return parts.slide(ref)
		},
		moved: (node, shapeId) => {
			history.parts = new Map([[node.part, { change: "changed", shapes: new Map([[shapeId, { kind: "xfrm" }]]) }]])
			history.revision++
		},
		async save(options = {}) {
			const { port1, port2 } = new MessageChannel()
			const uploading = upload(port2 as unknown as SavePortEnd, options.chunk)
			const result = await saveSession(
				{
					session,
					signal: { aborted: false, onAbort: () => undefined },
					lane: "background",
					slicing: options.slicing ?? SLICING
				},
				{ reason: "user", port: port1 as unknown as SavePortEnd },
				SAVE_DEPENDENCIES
			)

			return { result, file: await uploading }
		},
		close: () => {
			outcome.package.release?.()
		}
	}
}

// The SDK worker's side of the save port: the file once the stream ends, undefined when it aborted.
async function upload(port: SavePortEnd, chunk: ((bytes: Uint8Array) => void) | undefined): Promise<Uint8Array | undefined> {
	const reader = savePortReader(port)
	const parts: Uint8Array[] = []
	let size = 0

	try {
		for (let bytes = await reader.read(); bytes !== undefined; bytes = await reader.read()) {
			size += bytes.length

			if (chunk === undefined) parts.push(bytes)
			else chunk(bytes)
		}
	} catch {
		return undefined
	}

	reader.settled(true)

	const file = new Uint8Array(chunk === undefined ? size : 0)
	let at = 0

	for (const part of parts) {
		file.set(part, at)
		at += part.length
	}

	return file
}
