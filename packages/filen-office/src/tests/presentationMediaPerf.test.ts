import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs"
import { open } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { ByteSource } from "@filen/office/core/opc"
import { INFLATE_CHECKPOINT_BYTES } from "../core/opc/inflateIndex"
import type { CallSignal, EngineSession, Task } from "../dom/presentation/engine"
import { openPptxCapability, pptxParts } from "../dom/presentation/engine/open/pptx"
import { mediaServing, type MediaReader } from "../dom/presentation/media"
import type { PresentationEvent } from "../dom/presentation/protocol"
import { bigDeck, writeBigDeck } from "./fixtures/presentation/bigDeck"
import { liveHeap, liveHeapNow } from "./liveHeap"
import { budget, cpuMs } from "./timing"

// Media of large decks through the session: stored entries played by range with the worker's memory flat, deflated ones
// offered only once their index is built (so no read of the browser waits on the build), then sought with at most one
// checkpoint spacing of output work per read.

const MiB = 1024 * 1024
const SIGNAL: CallSignal = { aborted: false, onAbort: () => undefined }
const SLICING = { pause: () => new Promise<void>(resolve => setImmediate(resolve)), sliceMs: 8, now: () => performance.now() }
// What the service worker asks for at a time while a player streams.
const WINDOW = MiB

interface Opened {
	readonly session: EngineSession
	readonly tasks: Task[]
	readonly events: PresentationEvent[]
	close(): Promise<void>
}

async function openFile(path: string): Promise<Opened> {
	const handle = await open(path, "r")
	const { size } = await handle.stat()
	const source: ByteSource = {
		size,
		async read(offset, length) {
			const bytes = new Uint8Array(length)
			const { bytesRead } = await handle.read(bytes, 0, length, offset)

			return bytesRead === length ? bytes : bytes.subarray(0, bytesRead)
		}
	}
	const outcome = await openPptxCapability.open({ source, sourceKind: "range", options: { format: "pptx", fileName: "big.pptx" } })

	if (outcome.kind !== "opened") throw new Error(outcome.kind)

	const tasks: Task[] = []
	const events: PresentationEvent[] = []
	const session = {
		s: 1,
		deck: outcome.deck,
		package: outcome.package,
		options: { format: "pptx", fileName: "big.pptx" },
		services: {},
		rangeSource: undefined,
		schedule: (_lane: unknown, task: Task) => {
			tasks.push(task)
		},
		emit: (event: PresentationEvent) => {
			events.push(event)
		},
		onClose: () => undefined
	} as unknown as EngineSession

	for (const ref of outcome.deck.slides) await pptxParts(outcome.deck)?.slide(ref)

	return { session, tasks, events, close: () => handle.close() }
}

function mediaParts(session: EngineSession): string[] {
	const out: string[] = []

	for (const ref of session.deck.slides)
		for (const shape of session.deck.nodes.get(ref)?.shapes ?? []) if (shape.media?.part !== undefined) out.push(shape.media.part)

	return out
}

async function ready(opened: Opened, part: string): Promise<{ readonly read: MediaReader; readonly size: number }> {
	const serving = await mediaServing(opened.session, part)

	if (serving.kind === "refused") throw new Error(serving.reason)

	return { read: serving.read, size: serving.meta.size }
}

describe("presentationMediaPerf", () => {
	it("plays 1 GB of stored media by range with the worker's memory within 32 MiB", { timeout: budget(600_000) }, async () => {
		const opened = await openFile(await bigDeck("memory2g"))

		try {
			const parts = mediaParts(opened.session).slice(0, 4)
			const before = await liveHeap()
			let peak = before
			let total = 0

			for (const part of parts) {
				const { read, size } = await ready(opened, part)

				for (let at = 0, k = 0; at < size; at += WINDOW, k++) {
					total += (await read(at, Math.min(size, at + WINDOW), SIGNAL)).length

					if (k % 64 === 0) peak = Math.max(peak, liveHeapNow())
				}
			}

			expect(total).toBeGreaterThanOrEqual(1000 * MiB)
			expect(peak - before).toBeLessThanOrEqual(32 * MiB)
			process.stdout.write(
				`presentationMediaPerf: ${String(Math.round(total / MiB))} MiB stored media read, live heap +${((peak - before) / MiB).toFixed(1)} MiB\n`
			)
		} finally {
			await opened.close()
		}
	})

	it(
		"offers the 200 MB deflated video only once its index is built, then seeks within one checkpoint of work",
		{ timeout: budget(600_000) },
		async () => {
			const opened = await openFile(await bigDeck("video200"))

			try {
				const [part] = mediaParts(opened.session)

				if (part === undefined) throw new Error("no video")

				expect(await mediaServing(opened.session, part)).toEqual({ kind: "refused", reason: "preparing" })

				const start = cpuMs()

				for (const task of opened.tasks.splice(0)) await task(SLICING, SIGNAL)

				const build = cpuMs() - start
				const progress = opened.events.flatMap(event =>
					event.type === "notice" && event.notice.kind === "media" ? [event.notice.progress ?? 0] : []
				)

				expect(build).toBeLessThanOrEqual(2500)
				expect(progress.length).toBeGreaterThan(2)
				expect(progress.at(-1)).toBe(1)

				const { read, size } = await ready(opened, part)
				let slowest = 0

				// The moov box at the end first (what a player of a non-fast-start file reads), then seeks.
				for (const at of [size - 64 * 1024, 0, 150 * MiB, 20 * MiB, 199 * MiB, 75 * MiB + 333]) {
					const from = performance.now()
					const bytes = await read(at, Math.min(size, at + 64 * 1024), SIGNAL)

					slowest = Math.max(slowest, performance.now() - from)
					expect(bytes.length).toBe(Math.min(size, at + 64 * 1024) - at)
				}

				// Far from the 60 s a range read may go without progress before the port gives up on it.
				expect(slowest).toBeLessThan(5000)
				process.stdout.write(
					`presentationMediaPerf: index of 200 MB deflated built in ${build.toFixed(0)} ms CPU, slowest seek ${slowest.toFixed(0)} ms (checkpoints every ${String(INFLATE_CHECKPOINT_BYTES / MiB)} MiB)\n`
				)
			} finally {
				await opened.close()
			}
		}
	)

	it("offers a 1 GiB deflated video only once its index is complete", { timeout: budget(900_000) }, async () => {
		const dir = join(tmpdir(), "filen-office-big-decks")
		const path = join(dir, "video1g-v1.pptx")

		if (!existsSync(path)) {
			mkdirSync(dir, { recursive: true })

			const partial = `${path}.${String(process.pid)}.partial`
			const handle = await open(partial, "w")

			try {
				await writeBigDeck(
					{ media: [{ kind: "mp4", bytes: 1024 * MiB, deflate: true, faststart: false }], extraSlides: 0, seed: 4 },
					{
						write: async chunk => {
							await handle.write(chunk)
						},
						close: () => handle.close()
					}
				)
			} catch (error) {
				await handle.close().catch(() => undefined)
				rmSync(partial, { force: true })

				throw error
			}

			renameSync(partial, path)
		}

		const opened = await openFile(path)

		try {
			const [part] = mediaParts(opened.session)

			if (part === undefined) throw new Error("no video")

			const tasks = opened.tasks
			let asked = 0

			expect(await mediaServing(opened.session, part)).toEqual({ kind: "refused", reason: "preparing" })

			// Asked again while the build runs (a page retrying): preparing every time, until the build has finished.
			const task = tasks.shift()

			if (task === undefined) throw new Error("no build")

			let done = false
			const building = task(
				{
					...SLICING,
					pause: async () => {
						if (asked++ % 400 === 0)
							expect(await mediaServing(opened.session, part)).toEqual({ kind: "refused", reason: "preparing" })

						await SLICING.pause()
					}
				},
				SIGNAL
			).then(() => {
				done = true
			})

			await building
			expect(done).toBe(true)
			expect(asked).toBeGreaterThan(400)

			const { read, size } = await ready(opened, part)
			const from = performance.now()

			expect((await read(size - 4096, size, SIGNAL)).length).toBe(4096)
			expect(performance.now() - from).toBeLessThan(5000)
		} finally {
			await opened.close()
		}
	})
})
