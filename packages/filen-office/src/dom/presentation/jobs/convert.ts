import { PresentationError, refused } from "../../../core/presentation/model"
import { savePortReader, type SavePortEnd } from "../savePort"
import type { JobDefinition } from "./registry"

// A fresh package of the session (unsaved edits included) in the other format, or a gated deck's Transitional copy:
// the session writes it to a port of its own (freshParts), which this job reads chunk by chunk into its output, so no
// more than the port's window is in flight here. A refusal of the session (an encrypted deck to ODF, a pair with no
// conversion) is the job's.

type Channel = new () => { readonly port1: SavePortEnd; readonly port2: SavePortEnd }

const CONTENT_TYPES = {
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	odp: "application/vnd.oasis.opendocument.presentation"
} as const

export const convertJob: JobDefinition<"convert"> = {
	async run(request, context) {
		const Ports: unknown = Reflect.get(globalThis, "MessageChannel")

		if (typeof Ports !== "function") return refused("notImplemented", "convert job: no MessageChannel")

		const channel = new (Ports as Channel)()
		const reader = savePortReader(channel.port2)
		const answer = context.session.freshParts(request.target, channel.port1)
		let failure: unknown

		// A refusal ends the read (a session that refuses never writes to the port).
		answer.catch((error: unknown) => {
			failure = error
			reader.abort("failed")
		})
		context.signal.onAbort(() => {
			reader.abort("cancelled")
		})

		let bytes = 0

		try {
			for (let chunk = await reader.read(); chunk !== undefined; chunk = await reader.read()) {
				await context.output.write(chunk)
				bytes += chunk.length
			}

			const report = await answer

			await context.output.close()
			reader.settled(true)

			return { kind: "done", bytes, contentType: CONTENT_TYPES[request.target], report }
		} catch (error) {
			reader.settled(false)

			const cause = failure ?? error

			if (cause instanceof PresentationError) return refused(cause.reason, cause.message)

			throw cause
		} finally {
			channel.port1.close()
			channel.port2.close()
		}
	}
}
