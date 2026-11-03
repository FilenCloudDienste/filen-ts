import { MessageChannel } from "node:worker_threads"
import type { ByteSource } from "../core/opc/index"
import type { DeckOp } from "../core/presentation/edit/ops"
import { SERVICES, type CallContext, type EngineSession } from "../dom/presentation/engine"
import { createEditCapability, editCapability } from "../dom/presentation/engine/edit"
import type { EmitFunction } from "../core/presentation/edit/proof"
import { openOdpCapability } from "../dom/presentation/engine/open/odp"
import { openPptxCapability } from "../dom/presentation/engine/open/pptx"
import { SAVE_DEPENDENCIES } from "../dom/presentation/engine/save"
import { commitSavedSession, rebasableSource, saveSession, type SaveDependencies } from "../dom/presentation/save"
import { savePortAnnounced, savePortReader, type SavePortEnd } from "../dom/presentation/savePort"

// An engine session over a file store with versioning off (an upload replaces the file and the old version is gone),
// so each save goes through saveSession, the upload, commitSavedSession and the rebase, as in the app.

class Drive {
	readonly files = new Map<string, Uint8Array>()
	current = "v1"
	// Bytes of the upload under way that the drive holds (the server's, not the session's).
	received = 0
	private next = 1
	private readonly sample: (() => void) | undefined

	constructor(bytes: Uint8Array, sample?: () => void) {
		this.files.set("v1", bytes)
		this.sample = sample
	}

	// Bytes the drive holds: its files and the upload under way.
	held(): number {
		let bytes = this.received

		for (const file of this.files.values()) bytes += file.length

		return bytes
	}

	source(uuid: string): ByteSource {
		const of = (): Uint8Array => {
			const bytes = this.files.get(uuid)

			if (bytes === undefined) throw new Error(`gone ${uuid}`)

			return bytes
		}

		// A file the drive deleted reads as gone (its size as nothing): the port a late commit closes is never read.
		return {
			size: this.files.get(uuid)?.length ?? 0,
			read: (offset, length) =>
				Promise.resolve().then(() => {
					this.sample?.()

					return of().slice(offset, offset + length)
				})
		}
	}

	// An upload held open after its last byte until release() (hold()): a save's landing waits for it, so a test can
	// run commands between a snapshot and its landing.
	private gate: Promise<void> | undefined

	hold(): () => void {
		const held = Promise.withResolvers<void>()

		this.gate = held.promise

		return () => {
			this.gate = undefined
			held.resolve()
		}
	}

	async upload(port: InstanceType<typeof MessageChannel>["port1"], stallMs: number | undefined): Promise<string> {
		const reader = savePortReader(port as unknown as SavePortEnd, stallMs === undefined ? {} : { stallMs })
		const chunks: Uint8Array[] = []

		for (let chunk = await reader.read(); chunk !== undefined; chunk = await reader.read()) {
			chunks.push(chunk)
			this.received += chunk.length
			this.sample?.()
		}

		const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
		let at = 0

		for (const chunk of chunks) {
			out.set(chunk, at)
			at += chunk.length
		}

		await this.gate

		const uuid = `v${String(++this.next)}`

		this.files.set(uuid, out)
		this.received = 0
		this.files.delete(this.current)
		this.current = uuid
		reader.settled(true)

		return uuid
	}
}

// `stallMs`: the upload's stall (savePortReader's), for a test that waits it out; `commitWaitMs` and `inMemoryLimit`
// the save's (SaveDependencies); `emit` the emitters proof gate 1 checks with; `sample` is called on every read of the
// drive's files and every chunk it receives (a memory budget's sampler; drive.held() is what the drive holds);
// `dependencies` changes the save's (a writer that refuses, say).
export async function driveSession(
	bytes: Uint8Array,
	format: "odp" | "pptx" = "odp",
	events: unknown[] = [],
	tuning: {
		readonly stallMs?: number
		readonly commitWaitMs?: number
		readonly inMemoryLimit?: number
		readonly emit?: EmitFunction
		readonly sample?: () => void
		readonly dependencies?: (dependencies: SaveDependencies) => SaveDependencies
	} = {}
) {
	const drive = new Drive(bytes, tuning.sample)
	const options = { format, fileName: `deck.${format}` } as const
	const capability = format === "odp" ? openOdpCapability : openPptxCapability
	const outcome = await capability.open({ source: rebasableSource(drive.source("v1")), sourceKind: "range", options } as never)

	if (outcome.kind !== "opened") throw new Error(JSON.stringify(outcome))

	const session: EngineSession = {
		s: 1,
		deck: outcome.deck,
		package: outcome.package,
		options: options as never,
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
	// A save up to its upload's answer; commit() then moves the session onto the file made (the page's two calls, which a
	// test may interleave with another save).
	const edit = tuning.emit === undefined ? editCapability : createEditCapability({ emit: tuning.emit })
	const tuned: SaveDependencies = {
		...SAVE_DEPENDENCIES,
		...(tuning.commitWaitMs === undefined ? {} : { commitWaitMs: tuning.commitWaitMs }),
		...(tuning.inMemoryLimit === undefined ? {} : { inMemoryLimit: tuning.inMemoryLimit })
	}
	const dependencies = tuning.dependencies === undefined ? tuned : tuning.dependencies(tuned)
	const begin = async () => {
		const { port1, port2 } = new MessageChannel()
		// As the page does (presentationSaveEdits): the upload opens only once the session says it is going to write, and
		// its outcome is heard whatever the save answers (a save refused after it began aborts the upload).
		const uploading = savePortAnnounced(port2 as unknown as SavePortEnd)
			.then(write => (write ? drive.upload(port2, tuning.stallMs) : undefined))
			.then(
				uuid => ({ uuid }),
				(error: unknown) => ({ uuid: undefined, error })
			)
		const result = await saveSession(context, { reason: "user", port: port1 as unknown as SavePortEnd }, dependencies)
		const upload = result.kind === "written" ? await uploading : undefined

		if (upload !== undefined && "error" in upload) throw upload.error

		const uuid = upload?.uuid
		const bytes = uuid === undefined ? undefined : drive.files.get(uuid)

		port1.close()
		port2.close()

		return {
			result,
			bytes,
			commit: async (): Promise<{ readonly dirty: boolean } | undefined> =>
				result.kind === "written" && uuid !== undefined
					? await commitSavedSession(
							context,
							{
								file: { uuid, name: options.fileName },
								port: { uuid, postMessage: () => undefined, close: () => undefined } as never,
								size: bytes?.length ?? 0,
								revision: result.revision
							},
							dependencies
						)
					: undefined
		}
	}
	const save = async () => {
		const begun = await begin()

		await begun.commit()

		return { result: begun.result, bytes: begun.bytes }
	}

	return {
		drive,
		session,
		context,
		begin,
		save,
		command: (op: DeckOp) => edit.command(context, op),
		undo: () => edit.undo(context),
		redo: () => edit.redo(context)
	}
}
