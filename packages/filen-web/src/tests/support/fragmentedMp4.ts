import { BufferTarget, EncodedAudioPacketSource, EncodedPacket, EncodedVideoPacketSource, Mp4OutputFormat, Output } from "mediabunny"

// Fragmented MP4 as the export path writes it (mediabunny, fastStart "fragmented"): H.264 with a keyframe
// every GOP_FRAMES, optionally AAC, packets whose bytes name their frame.

// x264 High@L3.1, 1280x720.
export const AVC_PRIVATE = Uint8Array.from(
	Buffer.from("0164001fffe1001a6764001facd9405005bb011000000300100000030300f183196001000468ef89cbfdf8f800", "hex")
)
// AAC-LC, 48 kHz, stereo.
const AAC_CONFIG = Uint8Array.from([0x11, 0x90])

export const FPS = 25
export const GOP_FRAMES = 50

// One length-prefixed NAL unit (IDR or not) whose payload names the frame, so a located keyframe can be
// checked byte for byte.
export function videoPacket(frame: number, padding = 0): Uint8Array {
	const size = 200 + (frame % 7) * 13 + padding
	const bytes = new Uint8Array(4 + size)

	new DataView(bytes.buffer).setUint32(0, size)
	bytes[4] = frame % GOP_FRAMES === 0 ? 0x65 : 0x41
	bytes.fill(frame & 0xff, 5)
	new DataView(bytes.buffer).setUint32(5, frame)

	return bytes
}

// `padding` grows every video packet, for files that span several download blocks. `fastStart: "in-memory"` writes
// an ordinary MP4 (moov first, sample tables) instead. `audioFill(n)` is the byte audio packet n is filled with.
export async function fragmentedMp4(params: {
	seconds: number
	audio: boolean
	expectedDuration?: number
	padding?: number
	fastStart?: "fragmented" | "in-memory"
	audioFill?: (packet: number) => number
}): Promise<Uint8Array> {
	const output = new Output({
		format: new Mp4OutputFormat({
			fastStart: params.fastStart ?? "fragmented",
			...(params.expectedDuration === undefined ? {} : { expectedDuration: params.expectedDuration })
		}),
		target: new BufferTarget()
	})
	const video = new EncodedVideoPacketSource("avc")
	const audio = params.audio ? new EncodedAudioPacketSource("aac") : null

	output.addVideoTrack(video, { frameRate: FPS })

	if (audio !== null) {
		output.addAudioTrack(audio)
	}

	await output.start()

	const frames = params.seconds * FPS
	const audioPacketSeconds = 1024 / 48_000
	let audioTime = 0
	let audioPacket = 0

	for (let frame = 0; frame < frames; frame++) {
		const time = frame / FPS

		await video.add(
			new EncodedPacket(videoPacket(frame, params.padding), frame % GOP_FRAMES === 0 ? "key" : "delta", time, 1 / FPS),
			frame === 0
				? { decoderConfig: { codec: "avc1.64001f", codedWidth: 1280, codedHeight: 720, description: AVC_PRIVATE } }
				: undefined
		)

		while (audio !== null && audioTime < time + 1 / FPS) {
			await audio.add(
				new EncodedPacket(new Uint8Array(64).fill(params.audioFill?.(audioPacket) ?? 7), "key", audioTime, audioPacketSeconds),
				audioTime === 0
					? { decoderConfig: { codec: "mp4a.40.2", numberOfChannels: 2, sampleRate: 48_000, description: AAC_CONFIG } }
					: undefined
			)
			audioTime += audioPacketSeconds
			audioPacket++
		}
	}

	await output.finalize()

	const buffer = output.target.buffer

	if (buffer === null) {
		throw new Error("no output")
	}

	return new Uint8Array(buffer)
}
