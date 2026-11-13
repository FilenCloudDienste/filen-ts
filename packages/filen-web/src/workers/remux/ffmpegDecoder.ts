import { AudioSample, CustomAudioDecoder, type AudioCodec, type EncodedPacket } from "mediabunny"
import WORKER_SOURCE from "@/vendor/ffmpeg-decoders/decoders.worker.js?raw"
import { browserEngine, type BrowserEngine } from "@/lib/media/mseController.logic"

// AC-3, E-AC-3, DTS and TrueHD, which no browser decodes, ALAC, which only Safari does, and FLAC where the
// browser's own decoder fails, through FFmpeg's decoders built to WebAssembly
// (scripts/codecs/build-ffmpeg-decoders.sh). AC-3, E-AC-3, DTS and FLAC reach them through mediabunny's
// decoder registry; ALAC, which mediabunny does not know, and TrueHD, which it has no decoder for, through
// ffmpegSampleReader (batched: TrueHD units are tiny). The module runs in a worker of its own, nested in the
// remux worker, so decoding overlaps the remux worker's own work; the protocol is described in
// scripts/codecs/decoder-worker.js. The module is bundled into the remux worker and compiled only when a
// track first needs it.

// The codecs mediabunny hands to FFmpeg in `engine`. WebKit's WebCodecs claims FLAC (isConfigSupported says
// yes) and then fails on every frame, so only there FLAC goes to FFmpeg too; elsewhere the native decoder.
export function ffmpegDecodedCodecs(engine: BrowserEngine): readonly AudioCodec[] {
	return engine === "webkit" ? ["ac3", "eac3", "dts", "flac"] : ["ac3", "eac3", "dts"]
}

export type FfmpegCodec = "ac3" | "eac3" | "dts" | "truehd" | "alac" | "flac"

const FFMPEG_CODECS: ReadonlySet<string> = new Set<FfmpegCodec>(["ac3", "eac3", "dts", "truehd", "alac", "flac"])

export function isFfmpegCodec(codec: string | null): codec is FfmpegCodec {
	return codec !== null && FFMPEG_CODECS.has(codec)
}

export interface DecodedFrame {
	data: ArrayBuffer
	format: AudioSampleFormat
	channels: number
	// The planes' speakers as an FFmpeg AV_CH_* mask; -1 when the decoder could not name them.
	channelMask: number
	sampleRate: number
	frames: number
	// NaN when the decoder has no timestamp for it.
	timestampUs: number
}

export type DecoderRequest =
	// `extradata`: the codec configuration (ALAC's magic cookie in its 36-byte atom form, FLAC's STREAMINFO).
	| { type: "open"; codec: FfmpegCodec; extradata?: ArrayBuffer }
	| { type: "decode"; handle: number; data: ArrayBuffer; timestampUs: number }
	| { type: "flush"; handle: number }
	| { type: "close"; handle: number }

interface DecoderResponse {
	id: number
	error?: string
	// The module trapped: the worker has closed itself.
	fatal?: string
	handle?: number
	frames?: DecodedFrame[]
}

// A decoder open in the worker: its handle there, and the worker it lives in.
export interface DecoderLease {
	readonly handle: number
	readonly worker: Worker
}

// One worker for every open decoder, started with the first and terminated with the last: a seek opens
// the new decoder before closing the old one, so it is not restarted per seek. One that fails (a crash, a
// trap in the module, or a script the browser refused) is dropped with everything waiting on it and every
// decoder open in it, and the next decoder opened starts another.
export class DecoderWorker {
	private worker: Worker | null = null
	private users = 0
	private nextId = 0
	private readonly pending = new Map<number, { resolve: (response: DecoderResponse) => void; reject: (error: Error) => void }>()
	private readonly spawn: () => Worker

	public constructor(spawn: () => Worker) {
		this.spawn = spawn
	}

	// Every open, failed or not, is balanced by exactly one release.
	public async open(codec: FfmpegCodec, extradata?: Uint8Array): Promise<DecoderLease> {
		this.users++

		const worker = this.worker ?? this.start()
		// An empty configuration is none.
		const config = extradata === undefined || extradata.length === 0 ? undefined : extradata.slice().buffer
		const { handle } = await this.post(
			worker,
			config === undefined ? { type: "open", codec } : { type: "open", codec, extradata: config },
			config === undefined ? [] : [config]
		)

		if (handle === undefined) {
			throw new Error("the audio decoder worker returned no decoder")
		}

		return { handle, worker }
	}

	public request(lease: DecoderLease, request: DecoderRequest, transfer: Transferable[] = []): Promise<DecoderResponse> {
		if (lease.worker !== this.worker) {
			return Promise.reject(new Error("the audio decoder worker was lost"))
		}

		return this.post(lease.worker, request, transfer)
	}

	// Never throws: a decoder whose worker is gone is gone with it.
	public release(lease: DecoderLease | null): void {
		this.users--

		if (this.users <= 0) {
			this.users = 0
			this.stop(new Error("the audio decoder worker was stopped"))
		} else if (lease !== null && lease.worker === this.worker) {
			this.post(lease.worker, { type: "close", handle: lease.handle }).catch(() => undefined)
		}
	}

	private post(worker: Worker, request: DecoderRequest, transfer: Transferable[] = []): Promise<DecoderResponse> {
		const id = this.nextId++

		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject })
			worker.postMessage({ id, ...request }, transfer)
		})
	}

	private start(): Worker {
		const worker = this.spawn()

		worker.addEventListener("message", (event: MessageEvent<DecoderResponse>) => {
			const response = event.data

			if (response.fatal !== undefined) {
				if (this.worker === worker) {
					this.stop(new Error(response.fatal))
				}

				return
			}

			const waiting = this.pending.get(response.id)

			this.pending.delete(response.id)

			if (response.error === undefined) {
				waiting?.resolve(response)
			} else {
				waiting?.reject(new Error(response.error))
			}
		})
		worker.addEventListener("error", event => {
			event.preventDefault()

			if (this.worker === worker) {
				this.stop(new Error(event.message || "the audio decoder worker failed"))
			}
		})

		this.worker = worker

		return worker
	}

	private stop(error: Error): void {
		this.worker?.terminate()
		this.worker = null

		const waiting = [...this.pending.values()]

		this.pending.clear()

		for (const entry of waiting) {
			entry.reject(error)
		}
	}
}

// One Blob URL for the remux worker's lifetime, shared by every decoder worker it starts: the source is
// copied into a Blob once, and the URL goes with the remux worker's scope.
let workerUrl: string | null = null

function spawnBundledWorker(): Worker {
	workerUrl ??= URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }))

	return new Worker(workerUrl, { name: "ffmpeg-audio-decoders" })
}

// The AV_CH_* mask FFmpeg gave a decoded sample's planes, for the downmix to place them by.
const channelMasks = new WeakMap<AudioSample, number>()

export function decodedChannelMask(sample: AudioSample): number | null {
	return channelMasks.get(sample) ?? null
}

// Decoded frames as samples, each placed where FFmpeg says, or right after the previous one when it gives no
// timestamp; `next` is where the sample after them starts.
export function decodedSamples(frames: readonly DecodedFrame[], nextTimestamp: number): { samples: AudioSample[]; next: number } {
	const samples: AudioSample[] = []
	let next = nextTimestamp

	for (const frame of frames) {
		const timestamp = Number.isNaN(frame.timestampUs) ? next : frame.timestampUs / 1_000_000
		const sample = new AudioSample({
			data: frame.data,
			format: frame.format,
			numberOfChannels: frame.channels,
			sampleRate: frame.sampleRate,
			timestamp
		})

		if (frame.channelMask >= 0) {
			channelMasks.set(sample, frame.channelMask)
		}

		next = timestamp + frame.frames / frame.sampleRate
		samples.push(sample)
	}

	return { samples, next }
}

export function ffmpegAudioDecoder(worker: DecoderWorker, codecs: readonly AudioCodec[]): typeof CustomAudioDecoder {
	return class FfmpegAudioDecoder extends CustomAudioDecoder {
		private lease: DecoderLease | null = null
		private opening: Promise<DecoderLease> | null = null
		// Where the next sample starts when FFmpeg gives one no timestamp.
		private nextTimestamp = 0

		public static override supports(codec: AudioCodec): boolean {
			return codecs.includes(codec)
		}

		// Mediabunny chains every call on the one before, so none may reject: a rejection would skip every
		// later call, close() included, and keep the worker alive. Failures go to onError instead.
		public async init(): Promise<void> {
			const codec = this.codec

			// Never the case: supports() admits only these.
			if (!isFfmpegCodec(codec)) {
				this.onError(new Error(`no FFmpeg decoder for ${codec}`))

				return
			}

			const description = this.config.description

			this.opening = worker.open(
				codec,
				description === undefined
					? undefined
					: ArrayBuffer.isView(description)
						? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
						: new Uint8Array(description)
			)

			try {
				this.lease = await this.opening
			} catch (error) {
				this.onError(error)
			}
		}

		public async decode(packet: EncodedPacket): Promise<void> {
			try {
				const lease = this.opened()
				// A copy: the packet's bytes may be a view into a buffer the demuxer still uses.
				const data = packet.data.slice().buffer

				this.emit(
					await worker.request(lease, { type: "decode", handle: lease.handle, data, timestampUs: packet.microsecondTimestamp }, [
						data
					])
				)
			} catch (error) {
				this.onError(error)
			}
		}

		public async flush(): Promise<void> {
			try {
				const lease = this.opened()

				this.emit(await worker.request(lease, { type: "flush", handle: lease.handle }))
			} catch (error) {
				this.onError(error)
			}
		}

		public close(): void {
			if (this.opening !== null) {
				worker.release(this.lease)
				this.opening = null
				this.lease = null
			}
		}

		private opened(): DecoderLease {
			if (this.lease === null) {
				throw new Error("audio decoder used before it was opened, or after it was closed")
			}

			return this.lease
		}

		private emit(response: DecoderResponse): void {
			const decoded = decodedSamples(response.frames ?? [], this.nextTimestamp)

			this.nextTimestamp = decoded.next

			for (const sample of decoded.samples) {
				this.onSample(sample)
			}
		}
	}
}

// The one decoder worker of the remux worker, shared by mediabunny's decoders and ffmpegSampleReader.
export const ffmpegDecoders = new DecoderWorker(spawnBundledWorker)

export const FfmpegAudioDecoder = ffmpegAudioDecoder(ffmpegDecoders, ffmpegDecodedCodecs(browserEngine(navigator.userAgent)))
