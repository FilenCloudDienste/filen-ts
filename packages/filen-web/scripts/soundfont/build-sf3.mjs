// Converts the GeneralUser GS SoundFont (SF2) to SF3: every sample Ogg Vorbis-compressed by the reference libvorbis
// (wasm-media-encoders), written by spessasynth_core, the synthesizer that reads it. Run by build-sf3.sh, which pins
// and checks the inputs: node build-sf3.mjs <encoder package dir> <input.sf2> <output.sf3> <vorbis quality>.
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { SoundBankLoader } from "spessasynth_core"

const [encoderDir, input, output, quality] = process.argv.slice(2)
const { createOggEncoder } = await import(join(encoderDir, "dist/es/index.mjs"))
const encoder = await createOggEncoder()
const source = readFileSync(input)
const bank = SoundBankLoader.fromArrayBuffer(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength))

// One mono Vorbis stream per sample. A fixed stream serial number keeps the output the same from run to run.
async function compress(audio, sampleRate) {
	encoder.configure({ channels: 1, sampleRate, vbrQuality: Number(quality), oggSerialNo: 1 })

	const head = encoder.encode([audio]).slice()
	const tail = encoder.finalize().slice()
	const out = new Uint8Array(head.length + tail.length)

	out.set(head)
	out.set(tail, head.length)

	return out
}

await bank.setSampleFormat({ format: "compressed", compressionFunction: compress, rejectOnFailure: true })
writeFileSync(output, new Uint8Array(bank.writeSF2({ software: "filen-web build-sf3" })))
