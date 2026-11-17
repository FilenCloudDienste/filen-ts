import { AudioSample, CustomAudioDecoder, type AudioCodec, type EncodedPacket } from "mediabunny"
import WORKER_SOURCE from "@/vendor/ffmpeg-decoders/decoders.worker.js?raw"
import { browserEngine, type BrowserEngine } from "@/lib/media/mseController.logic"
import { NestedWorker, type NestedResponse } from "@/workers/nestedWorker"

// AC-3, E-AC-3, DTS, TrueHD, WMA, MP1/MP2, AMR and ADPCM, which no browser decodes, ALAC, which only Safari does,
// and FLAC where the browser's own decoder fails, through FFmpeg's decoders built to WebAssembly
// (scripts/codecs/build-ffmpeg-decoders.sh). AC-3, E-AC-3, DTS and FLAC reach them through mediabunny's
// decoder registry; the codecs mediabunny does not know (ALAC, WMA, MP1/MP2, AMR, ADPCM) and TrueHD, which it has
// no decoder for, through
// ffmpegSampleReader (batched: TrueHD units are tiny). The module runs in a worker of its own, nested in the
// remux worker, so decoding overlaps the remux worker's own work; the protocol is described in
// scripts/codecs/decoder-worker.js. The module is bundled into the remux worker and compiled only when a
// track first needs it.

// The codecs mediabunny hands to FFmpeg in `engine`. WebKit's WebCodecs claims FLAC (isConfigSupported says
// yes) and then fails on every frame, so only there FLAC goes to FFmpeg too; elsewhere the native decoder.
export function ffmpegDecodedCodecs(engine: BrowserEngine): readonly AudioCodec[] {
	return engine === "webkit" ? ["ac3", "eac3", "dts", "flac"] : ["ac3", "eac3", "dts"]
}

const FFMPEG_CODEC_NAMES = [
	"ac3",
	"eac3",
	"dts",
	"truehd",
	"alac",
	"flac",
	"wmav1",
	"wmav2",
	"wmapro",
	"wmalossless",
	"mp1",
	"mp2",
	"amrnb",
	"amrwb",
	"adpcm_ms",
	"adpcm_ima_wav",
	"adpcm_swf",
	"pcm_dvd"
] as const

export type FfmpegCodec = (typeof FFMPEG_CODEC_NAMES)[number]

const FFMPEG_CODECS: ReadonlySet<string> = new Set<FfmpegCodec>(FFMPEG_CODEC_NAMES)

// A stream's WAVEFORMATEX fields, for the decoders that read no header of their own: WMA and ADPCM need the block
// size, WMA the bit rate, ADPCM the bits per sample.
export interface FfmpegStream {
	blockAlign: number
	bitRate: number
	sampleRate: number
	channels: number
	bitsPerSample: number
}

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
	// `extradata`: the codec configuration (ALAC's magic cookie in its 36-byte atom form, FLAC's STREAMINFO, the extra
	// bytes of a WAVEFORMATEX).
	| { type: "open"; codec: FfmpegCodec; extradata?: ArrayBuffer; stream?: FfmpegStream }
	| { type: "decode"; handle: number; data: ArrayBuffer; timestampUs: number }
	| { type: "flush"; handle: number }
	| { type: "close"; handle: number }

interface DecoderResponse extends NestedResponse {
	handle?: number
	frames?: DecodedFrame[]
}

// A decoder open in the worker: its handle there, and the worker it lives in.
export interface DecoderLease {
	readonly handle: number
	readonly worker: Worker
}

// One worker for every open decoder, started with the first and terminated with the last: a seek opens
// the new decoder before closing the old one, so it is not restarted per seek. One that fails is dropped with every
// decoder open in it (NestedWorker), and the next decoder opened starts another.
export class DecoderWorker {
	private readonly nested: NestedWorker<DecoderRequest, DecoderResponse>

	public constructor(spawn: () => Worker) {
		this.nested = new NestedWorker(spawn, { name: "audio decoder" })
	}

	// Every open that resolves is balanced by exactly one release of its lease; one that fails releases its worker
	// itself. Aborted while under way, it releases the worker at once (which may stop it) rather than when it settles,
	// and a decoder it opened after all is closed.
	public async open(codec: FfmpegCodec, extradata?: Uint8Array, stream?: FfmpegStream, signal?: AbortSignal): Promise<DecoderLease> {
		const worker = this.nested.acquire()
		// Set by an abort, which lands while the open awaits.
		const state = { released: false }
		const release = (): void => {
			if (!state.released) {
				state.released = true
				this.nested.release(worker)
			}
		}

		signal?.addEventListener("abort", release, { once: true })

		try {
			// An empty configuration is none.
			const config = extradata === undefined || extradata.length === 0 ? undefined : extradata.slice().buffer
			const { handle } = await this.nested.request(
				worker,
				{
					type: "open",
					codec,
					...(config === undefined ? {} : { extradata: config }),
					...(stream === undefined ? {} : { stream })
				},
				config === undefined ? [] : [config]
			)

			if (handle === undefined) {
				throw new Error("the audio decoder worker returned no decoder")
			}

			if (state.released) {
				if (this.nested.current(worker)) {
					this.nested.request(worker, { type: "close", handle }).catch(() => undefined)
				}

				throw new DOMException("the decoder was closed while it opened", "AbortError")
			}

			return { handle, worker }
		} catch (error) {
			release()

			throw error
		} finally {
			signal?.removeEventListener("abort", release)
		}
	}

	public request(lease: DecoderLease, request: DecoderRequest, transfer: Transferable[] = []): Promise<DecoderResponse> {
		return this.nested.request(lease.worker, request, transfer)
	}

	// Never throws: a decoder whose worker is gone is gone with it.
	public release(lease: DecoderLease): void {
		if (this.nested.current(lease.worker)) {
			this.nested.request(lease.worker, { type: "close", handle: lease.handle }).catch(() => undefined)
		}

		this.nested.release(lease.worker)
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
		// Aborts an open still under way when the decoder closes.
		private readonly closing = new AbortController()
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
						: new Uint8Array(description),
				undefined,
				this.closing.signal
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
			const opening = this.opening

			if (opening !== null) {
				// An open still under way is aborted, releasing its worker now; one that landed is released.
				this.closing.abort()
				opening.then(
					lease => {
						worker.release(lease)
					},
					() => undefined
				)
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
