import { open } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import { ZipArchive, type ByteSource } from "@filen/office/core/opc"
import { PRESENTATION_ZIP_LIMITS } from "../core/opc/mediaPolicy"
import { INFLATE_CHECKPOINT_BYTES, InflateIndex } from "../core/opc/inflateIndex"
import { bigDeck } from "./fixtures/presentation/bigDeck"
import { budget, cpuMs } from "./timing"

// The index of the generated deck's 200 MB deflated, non-fast-start MP4: built in at most 2.5 s CPU, then any seek
// inflates at most one checkpoint spacing (2 MiB) of output before the bytes it returns.

const MiB = 1024 * 1024

describe("inflateIndexPerf", () => {
	it(
		"indexes a 200 MB deflated video in at most 2.5 s CPU; a seek costs at most 2 MiB of output work",
		{ timeout: budget(300_000) },
		async () => {
			const path = await bigDeck("video200")
			const handle = await open(path, "r")

			try {
				const { size } = await handle.stat()
				const source: ByteSource = {
					size,
					async read(offset, length) {
						const bytes = new Uint8Array(length)
						const { bytesRead } = await handle.read(bytes, 0, length, offset)

						return bytesRead === length ? bytes : bytes.subarray(0, bytesRead)
					}
				}
				const archive = await ZipArchive.open(source, { limits: PRESENTATION_ZIP_LIMITS })
				const entry = archive.get("ppt/media/media1.mp4")

				if (entry === undefined) throw new Error("no video in the deck")

				expect(entry.method).toBe(8)
				expect(entry.uncompressedSize).toBe(200 * MiB)

				const { dataOffset } = await archive.layout(entry)
				const input = {
					size: entry.compressedSize,
					read: (offset: number, length: number) => source.read(dataOffset + offset, length)
				}
				let best = Number.POSITIVE_INFINITY
				let index: InflateIndex | undefined

				for (let run = 0; run < 2; run++) {
					const start = cpuMs()

					index = await InflateIndex.build(input, { size: entry.uncompressedSize, crc32: entry.crc32 })
					best = Math.min(best, cpuMs() - start)
				}

				if (index === undefined) throw new Error("no index")

				expect(best).toBeLessThanOrEqual(2500)
				// About 32 KiB per 2 MiB of output.
				expect(index.windowBytes).toBeLessThanOrEqual(
					Math.ceil(entry.uncompressedSize / INFLATE_CHECKPOINT_BYTES + 1) * (32 * 1024 + 320)
				)

				// The moov box at the end (what a player reads first), then seeks across the media data.
				const stats = { work: 0 }
				let worst = 0

				for (const offset of [entry.uncompressedSize - 4096, 3, 50 * MiB + 12_345, 199 * MiB, 100 * MiB - 1, 7 * MiB]) {
					const length = Math.min(64 * 1024, entry.uncompressedSize - offset)

					await index.read(offset, length, stats)
					worst = Math.max(worst, stats.work - length)
				}

				expect(worst).toBeLessThanOrEqual(INFLATE_CHECKPOINT_BYTES + 258)
				process.stdout.write(
					`inflateIndexPerf: build ${best.toFixed(0)} ms CPU, ${String(index.checkpoints.length)} checkpoints, ${(index.windowBytes / MiB).toFixed(2)} MiB of windows, worst seek ${(worst / MiB).toFixed(2)} MiB of output work\n`
				)
			} finally {
				await handle.close()
			}
		}
	)
})
