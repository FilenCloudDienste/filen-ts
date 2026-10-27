import { MessageChannel } from "node:worker_threads"
import type { ByteSource } from "../core/opc/index"
import type { DeckOp } from "../core/presentation/edit/ops"
import { SERVICES, type CallContext, type EngineSession } from "../dom/presentation/engine"
import { editCapability } from "../dom/presentation/engine/edit"
import { openOdpCapability } from "../dom/presentation/engine/open/odp"
import { openPptxCapability } from "../dom/presentation/engine/open/pptx"
import { SAVE_DEPENDENCIES } from "../dom/presentation/engine/save"
import { commitSavedSession, rebasableSource, saveSession } from "../dom/presentation/save"
import { savePortReader, type SavePortEnd } from "../dom/presentation/savePort"

// An engine session over a file store with versioning off (an upload replaces the file and the old version is gone),
// so each save goes through saveSession, the upload, commitSavedSession and the rebase, as in the app.

class Drive {
	readonly files = new Map<string, Uint8Array>()
	current = "v1"
	private next = 1

	constructor(bytes: Uint8Array) {
		this.files.set("v1", bytes)
	}

	source(uuid: string): ByteSource {
		const of = (): Uint8Array => {
			const bytes = this.files.get(uuid)

			if (bytes === undefined) throw new Error(`gone ${uuid}`)

			return bytes
		}

		return { size: of().length, read: (offset, length) => Promise.resolve(of().slice(offset, offset + length)) }
	}

	async upload(port: InstanceType<typeof MessageChannel>["port1"]): Promise<string> {
		const reader = savePortReader(port as unknown as SavePortEnd)
		const chunks: Uint8Array[] = []

		for (let chunk = await reader.read(); chunk !== undefined; chunk = await reader.read()) chunks.push(chunk)

		const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
		let at = 0

		for (const chunk of chunks) {
			out.set(chunk, at)
			at += chunk.length
		}

		const uuid = `v${String(++this.next)}`

		this.files.set(uuid, out)
		this.files.delete(this.current)
		this.current = uuid
		reader.settled(true)

		return uuid
	}
}

export async function driveSession(bytes: Uint8Array, format: "odp" | "pptx" = "odp", events: unknown[] = []) {
	const drive = new Drive(bytes)
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
	const save = async () => {
		const { port1, port2 } = new MessageChannel()
		const uploading = drive.upload(port2)
		const result = await saveSession(context, { reason: "user", port: port1 as unknown as SavePortEnd }, SAVE_DEPENDENCIES)
		const uuid = result.kind === "written" ? await uploading : undefined

		port1.close()
		port2.close()

		if (result.kind === "written" && uuid !== undefined) {
			await commitSavedSession(
				context,
				{
					file: { uuid, name: options.fileName },
					port: { uuid, postMessage: () => undefined, close: () => undefined } as never,
					size: drive.files.get(uuid)?.length ?? 0,
					revision: result.revision
				},
				SAVE_DEPENDENCIES
			)
		}

		return { result, bytes: uuid === undefined ? undefined : drive.files.get(uuid) }
	}

	return {
		drive,
		session,
		context,
		save,
		command: (op: DeckOp) => editCapability.command(context, op),
		undo: () => editCapability.undo(context),
		redo: () => editCapability.redo(context)
	}
}
