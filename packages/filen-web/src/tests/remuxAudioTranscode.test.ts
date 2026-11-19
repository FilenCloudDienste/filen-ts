import { describe, expect, it, vi } from "vitest"
import { BlockAbortError } from "@/lib/media/blockCache"
import type { RemuxStats } from "@/lib/media/remuxTypes"
import { sampleReader, TranscodeWriter, type SampleItem } from "@/workers/remux/audioTranscode"
import type { EncoderTarget } from "@/workers/remux/audioMix.logic"
import type { FragmentedTrackOutput } from "@/workers/remux/output"

interface FakeSample {
	timestamp: number
	duration: number
	close: () => void
}

// What each `samples(time)` call of the fake sink decodes, in call order: samples, then an abort or the end.
const decode = vi.hoisted(() => ({
	starts: [] as number[],
	runs: [] as { samples: FakeSample[]; abort: boolean }[]
}))

vi.mock("mediabunny", async importOriginal => ({
	...(await importOriginal<typeof import("mediabunny")>()),
	AudioSampleSink: class {
		public async *samples(time: number): AsyncGenerator<FakeSample, void, unknown> {
			decode.starts.push(time)

			const run = decode.runs[decode.starts.length - 1]

			for (const sample of run?.samples ?? []) {
				yield await Promise.resolve(sample)
			}

			if (run?.abort === true) {
				throw new BlockAbortError()
			}
		}
	}
}))

function decodes(...runs: { samples: FakeSample[]; abort: boolean }[]): void {
	decode.starts = []
	decode.runs = runs
}

const sample = (timestamp: number): FakeSample => ({ timestamp, duration: 1, close: vi.fn() })

function reader(isCancelled = (): boolean => false): ReturnType<typeof sampleReader> {
	return sampleReader({} as never, { decodeWaitSeconds: 0 } as RemuxStats, isCancelled)
}

describe("sampleReader", () => {
	it("restarts once where it left off after an aborted read and drops what ends before that", async () => {
		const stale = sample(1)

		decodes({ samples: [sample(0), sample(1)], abort: true }, { samples: [stale, sample(2)], abort: false })

		const samples = reader()
		const first = await samples.first(0)
		const second = first === null ? null : await samples.next(first)
		const third = second === null ? null : await samples.next(second)

		expect([first?.timestamp, second?.timestamp, third?.timestamp]).toEqual([0, 1, 2])
		expect(decode.starts).toEqual([0, 2])
		expect(stale.close).toHaveBeenCalledOnce()
	})

	it("rethrows a second abort in the same read", async () => {
		decodes({ samples: [], abort: true }, { samples: [], abort: true })

		await expect(reader().first(5)).rejects.toBeInstanceOf(BlockAbortError)
		expect(decode.starts).toEqual([5, 5])
	})

	it("rethrows an abort once the pump is cancelled", async () => {
		decodes({ samples: [], abort: true }, { samples: [sample(5)], abort: false })

		await expect(reader(() => true).first(5)).rejects.toBeInstanceOf(BlockAbortError)
		expect(decode.starts).toEqual([5])
	})
})

// An encoder that fails as soon as it is configured, the way a platform encoder reports a broken config.
class FailingEncoder {
	public state = "configured"
	public encodeQueueSize = 0
	private readonly onError: (error: Error) => void

	public constructor(init: { error: (error: Error) => void }) {
		this.onError = init.error
	}

	public configure(): void {
		this.onError(new Error("encoder broke"))
	}

	public close(): void {
		this.state = "closed"
	}
}

describe("TranscodeWriter", () => {
	it("closes the decoded sample when the encoder has already failed", async () => {
		vi.stubGlobal("AudioEncoder", FailingEncoder)

		const writer = new TranscodeWriter({
			target: { target: "aac", codec: "mp4a.40.2" } satisfies EncoderTarget,
			output: {} as FragmentedTrackOutput,
			stats: { transcodeSeconds: 0, transcodedMediaSeconds: 0 } as RemuxStats,
			layout: () => []
		})
		const close = vi.fn()
		const item = { sample: { close }, timestamp: 0, duration: 0.02, type: "key" } as unknown as SampleItem

		await expect(writer.write(item)).rejects.toThrow("encoder broke")
		expect(close).toHaveBeenCalledOnce()
	})
})
