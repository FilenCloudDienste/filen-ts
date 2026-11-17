import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { tinyMod } from "../../src/tests/support/trackerModules"
import { scenarioModule } from "./scenarios"

// The media workstream's files (preview-synth.spec.ts, preview-legacy-media.spec.ts, preview-legacy-bframes.spec.ts):
// tracker modules and a MIDI song generated here, the demuxer tests' legacy containers (AVI, ASF and an MPEG program
// stream, also as a camcorder `.mod`, all H.264 with B-frames), H.264 with MP2 sound in a transport stream, and an MP4
// with two audio tracks. The last two were written by ffmpeg 8.1 (libx264, aac, mp2, bit-exact):
//   ffmpeg -f lavfi -i testsrc=size=160x90:rate=25:duration=3 -f lavfi -i sine=440:sample_rate=48000:duration=3
//     -f lavfi -i sine=660:sample_rate=48000:duration=3 -map 0:v -map 1:a -map 2:a -c:v libx264 -crf 35 -g 25 -bf 0
//     -c:a aac -metadata:s:a:0 language=eng -metadata:s:a:1 language=deu -movflags +faststart tracks.mp4
//   ffmpeg (the first two inputs) -c:v libx264 -crf 35 -g 25 -bf 0 -c:a mp2 -f mpegts h264-mp2.m2ts

const MEDIA = fileURLToPath(new URL("./media/", import.meta.url))
const DEMUX = fileURLToPath(new URL("../../src/tests/fixtures/demux/", import.meta.url))

function vlq(value: number): number[] {
	const out = [value & 0x7f]

	for (let rest = value >> 7; rest > 0; rest >>= 7) {
		out.unshift((rest & 0x7f) | 0x80)
	}

	return out
}

// Two seconds of piano: eight eighths at 120 BPM.
export function tinyMidi(): Buffer {
	const events = [0x00, 0xc0, 0x00]

	for (let i = 0; i < 8; i++) {
		events.push(...vlq(i === 0 ? 0 : 1), 0x90, 60 + i, 100, ...vlq(239), 0x80, 60 + i, 0)
	}

	events.push(0x00, 0xff, 0x2f, 0x00)

	const length = events.length

	return Buffer.from([
		...Buffer.from("MThd"),
		0,
		0,
		0,
		6,
		0,
		0,
		0,
		1,
		0x01,
		0xe0,
		...Buffer.from("MTrk"),
		length >>> 24,
		(length >> 16) & 0xff,
		(length >> 8) & 0xff,
		length & 0xff,
		...events
	])
}

export const W5_SCENARIOS = scenarioModule(
	{
		"preview-synth": ["chiptune.mod", "chiptune-15.mod", "piano.mid"],
		"preview-mod-video": ["camcorder.mod"],
		// A transport stream named `.ts` reads as one only from 1 MiB (smaller is TypeScript), so this one is `.m2ts`.
		"preview-legacy-media": ["legacy.avi", "legacy.asf", "legacy.vob", "legacy-mp2.m2ts"],
		"preview-audio-tracks": ["two-tracks.mp4"],
		"preview-legacy-bframes": ["bframes.avi", "bframes.asf", "bframes.vob"]
	},
	() => ({
		"chiptune.mod": { buffer: Buffer.from(tinyMod(31)), mimeType: "audio/x-mod" },
		// No signature: only the row's hint names it a tracker module.
		"chiptune-15.mod": { buffer: Buffer.from(tinyMod(15)), mimeType: "application/octet-stream" },
		"piano.mid": { buffer: tinyMidi(), mimeType: "audio/midi" },
		"camcorder.mod": { buffer: readFileSync(`${DEMUX}h264-ac3.vob`), mimeType: "application/octet-stream" },
		"legacy.avi": { buffer: readFileSync(`${DEMUX}h264-bframes-mp3.avi`), mimeType: "video/x-msvideo" },
		"legacy.asf": { buffer: readFileSync(`${DEMUX}h264-mp3.asf`), mimeType: "video/x-ms-asf" },
		"legacy.vob": { buffer: readFileSync(`${DEMUX}h264-ac3.vob`), mimeType: "video/mpeg" },
		"legacy-mp2.m2ts": { buffer: readFileSync(`${MEDIA}h264-mp2.m2ts`), mimeType: "video/mp2t" },
		"two-tracks.mp4": { buffer: readFileSync(`${MEDIA}tracks.mp4`), mimeType: "video/mp4" },
		"bframes.avi": { buffer: readFileSync(`${DEMUX}h264-bframes-mp3.avi`), mimeType: "video/x-msvideo" },
		"bframes.asf": { buffer: readFileSync(`${DEMUX}h264-mp3.asf`), mimeType: "video/x-ms-asf" },
		"bframes.vob": { buffer: readFileSync(`${DEMUX}h264-ac3.vob`), mimeType: "video/mpeg" }
	})
)
