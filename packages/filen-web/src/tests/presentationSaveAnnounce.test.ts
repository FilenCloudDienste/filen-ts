import { afterEach, describe, expect, it } from "vitest"
import { savePortReader, savePortWriter, type SavePortEnd } from "@filen/shared/savePort"
import type { PortLike, SaveResult } from "@filen/office/dom/presentation"
import { presentationSaveEdits } from "@/features/drive/lib/previewSave.logic"

// A deck's save opens an upload only once the session says it writes: a save with nothing to write (every edit
// undone) or refused ends before any upload, and the channel's end the upload would have read is closed.

const opened: MessagePort[] = []

afterEach(() => {
	for (const port of opened.splice(0)) port.close()
})

function writerOn(port: PortLike): ReturnType<typeof savePortWriter> {
	opened.push(port as MessagePort)

	return savePortWriter(port as SavePortEnd, { lingerMs: 50 })
}

describe("presentation save announce", () => {
	it("opens no upload for a save that writes nothing", async () => {
		const session = {
			save: ({ port }: { readonly port: PortLike }) => {
				writerOn(port).abort("unchanged")

				return Promise.resolve<SaveResult>({ kind: "unchanged" })
			},
			commitSaved: () => Promise.resolve({ dirty: false })
		}
		const edits = presentationSaveEdits(session, () => undefined, true)

		expect(await edits.announced).toBe(false)
		expect(await edits.result).toEqual({ kind: "unchanged" })
	})

	it("opens the upload once the session writes, and the upload reads every byte", async () => {
		let written: Promise<void> | undefined
		const session = {
			save: ({ port }: { readonly port: PortLike }) => {
				const writer = writerOn(port)

				writer.announce()
				written = (async () => {
					await writer.write(new Uint8Array([7, 8, 9]))
					await writer.close()
					writer.commit()
				})()

				return new Promise<SaveResult>(() => undefined)
			},
			commitSaved: () => Promise.resolve({ dirty: false })
		}
		const edits = presentationSaveEdits(session, () => undefined, false)

		expect(await edits.announced).toBe(true)

		const reader = savePortReader(edits.port)

		opened.push(edits.port)
		expect(await reader.read()).toEqual(new Uint8Array([7, 8, 9]))
		await written
		expect(await reader.read()).toBeUndefined()
		reader.settled(true)
	})
})
