import { describe, expect, it } from "vitest"
import { memorySink } from "@filen/office/core/opc"
import { PresentationError } from "../core/presentation/model"
import { servePresentation } from "../dom/presentation/engine"
import { convertJob } from "../dom/presentation/jobs/convert"
import type { JobContext } from "../dom/presentation/jobs/registry"
import type { PortLike, PresentationEvent } from "../dom/presentation/protocol"
import { savePortReader, savePortWriter, type SavePortEnd } from "../dom/presentation/savePort"
import { CallRefused, loopback, LoopbackSession } from "./fixtures/presentation/loopback"
import { odpDeck } from "./odpWriteFixtures"
import { buildPpt, FIXTURE_PNG, type FixtureOptions } from "./pptFixtures"
import { budget } from "./timing"

// Conversions through the presentation worker's protocol (freshParts over the loopback, the package read from the
// save port as the page reads it), and the jobs worker's convert job reading the session's port into its output.

const PPT: FixtureOptions = {
	slides: [{ shapes: [{ text: "Hello", textType: 0, placeholder: { type: 13, position: 0 }, anchor: [100, 300, 5400, 700] }] }],
	png: FIXTURE_PNG
}

async function opened(
	bytes: Uint8Array,
	options: { readonly format: "odp" | "ppt"; readonly fileName: string; readonly viewOnly?: boolean },
	password?: string
): Promise<{ readonly session: LoopbackSession; readonly stop: () => void }> {
	const channel = loopback()
	const stop = servePresentation(channel.worker)
	const session = new LoopbackSession(channel.page, 1)
	let event: Promise<PresentationEvent> = session.nextEvent()

	channel.page.post({ t: "open", s: 1, source: { kind: "bytes", bytes }, options })

	if (password !== undefined) {
		expect(await event).toMatchObject({ type: "error", reason: "needsPassword" })
		event = session.nextEvent()
		channel.page.post({ t: "unlock", s: 1, password })
	}

	expect(await event).toMatchObject({ type: "opened" })

	return { session, stop }
}

async function drain(port: SavePortEnd): Promise<Uint8Array> {
	const reader = savePortReader(port)
	const parts: Uint8Array[] = []

	for (let chunk = await reader.read(); chunk !== undefined; chunk = await reader.read()) parts.push(chunk)

	reader.settled(true)

	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
	let at = 0

	for (const part of parts) {
		out.set(part, at)
		at += part.length
	}

	return out
}

function channel(): { readonly ours: SavePortEnd; readonly theirs: SavePortEnd } {
	const ports = new MessageChannel()

	return { ours: ports.port2 as unknown as SavePortEnd, theirs: ports.port1 as unknown as SavePortEnd }
}

describe("conversions through the presentation worker", () => {
	it("streams an ODP deck as a .pptx package through the port", async () => {
		const { session, stop } = await opened(odpDeck(), { format: "odp", fileName: "Deck.odp" })
		const port = channel()
		const read = drain(port.ours)
		const report = await session.call("freshParts", "pptx", port.theirs).answer
		const bytes = await read

		expect(report.target).toBe("pptx")
		expect(report.bytes).toBe(bytes.length)
		expect([...bytes.subarray(0, 2)]).toEqual([0x50, 0x4b])
		stop()
	})

	// About 1.8 s alone (0.6 s CPU on the test thread: the ppt read and its conversion), well over the default 5 s under
	// the full suite's load.
	it("seals a password-protected deck's .pptx copy and refuses its .odp copy", { timeout: budget(20_000) }, async () => {
		const { session, stop } = await opened(
			(await buildPpt({ ...PPT, password: "secret" })).bytes,
			{
				format: "ppt",
				fileName: "Deck.ppt",
				viewOnly: true
			},
			"secret"
		)
		const refusedPort = channel()
		const refusal = await session.call("freshParts", "odp", refusedPort.theirs).answer.then(
			() => undefined,
			(error: unknown) => error
		)

		expect(refusal).toBeInstanceOf(CallRefused)
		expect((refusal as CallRefused).reason).toBe("encrypted")

		const port = channel()
		const read = drain(port.ours)

		await session.call("freshParts", "pptx", port.theirs).answer

		// An OLE2 compound file around the encrypted package (MS-OFFCRYPTO §2.3.4.1).
		expect([...(await read).subarray(0, 4)]).toEqual([0xd0, 0xcf, 0x11, 0xe0])
		stop()
	})
})

function jobContext(
	freshParts: (target: "pptx" | "odp", port: PortLike) => Promise<{ target: "pptx" | "odp"; bytes: number; losses: [] }>
) {
	const output = memorySink()
	const context: JobContext = {
		session: {
			render: () => Promise.resolve([]),
			media: () => Promise.resolve({ kind: "refused", reason: "notImplemented" }),
			freshParts
		},
		output,
		signal: { aborted: false, onAbort: () => undefined },
		progress: () => undefined
	}

	return { context, output }
}

describe("the convert job", () => {
	it("reads the session's package from its port into the job's output", async () => {
		const { context, output } = jobContext(async (target, port) => {
			const writer = savePortWriter(port as SavePortEnd)

			writer.announce()
			await writer.write(new Uint8Array([1, 2, 3]))
			await writer.write(new Uint8Array([4, 5]))
			await writer.close()
			writer.commit()

			return { target, bytes: 5, losses: [] }
		})

		expect(await convertJob.run({ target: "odp" }, context)).toEqual({
			kind: "done",
			bytes: 5,
			contentType: "application/vnd.oasis.opendocument.presentation",
			report: { target: "odp", bytes: 5, losses: [] }
		})
		expect([...output.bytes()]).toEqual([1, 2, 3, 4, 5])
	})

	it("answers the session's refusal as its own", async () => {
		const { context } = jobContext(() =>
			Promise.reject(new PresentationError("encrypted", "An OpenDocument copy cannot keep the password"))
		)

		expect(await convertJob.run({ target: "odp" }, context)).toMatchObject({ kind: "refused", reason: "encrypted" })
	})
})
