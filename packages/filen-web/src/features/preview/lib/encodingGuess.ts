import { ENCODING_DETECT_WASM } from "virtual:encoding-detect"
import { EncodingDetector } from "@filen/encoding-detect"
import { registerPreviewDisposer } from "@/lib/workers/previewDisposers"
import { log } from "@/lib/log"
import { readAsLegacy, readTextFile, type TextFile } from "@/features/preview/lib/textFile"

// The legacy encoding detector (chardetng as wasm), loaded the first time a text file turns out not to be Unicode and
// kept for the session: its scratch region holds the head of the last file asked about, so sign-out drops it.
let detector: Promise<EncodingDetector> | null = null

function load(): Promise<EncodingDetector> {
	const loading = WebAssembly.compileStreaming(fetch(ENCODING_DETECT_WASM)).then(module => EncodingDetector.instantiate(module))

	registerPreviewDisposer("encodingDetector", () => {
		if (detector === loading) {
			detector = null
		}
	})

	return loading
}

// The legacy encoding (a WHATWG label) the bytes most likely are, from their first MiB; ask only for bytes that are not
// Unicode (decodeTextBytes fell back to a codepage). `last`: the bytes are the whole file. null when the detector
// cannot load, so the caller keeps the language's codepage.
export async function guessLegacyEncoding(bytes: Uint8Array, last: boolean): Promise<string | null> {
	const pending = (detector ??= load())

	try {
		return (await pending).guess(bytes, last)
	} catch (e) {
		if (detector === pending) {
			detector = null
		}

		log.error("preview", "guessing a text file's encoding failed", e)

		return null
	}
}

// readTextFile with the detector's guess for bytes that are not Unicode (one decode for those that are).
export async function readTextFileDetected(bytes: Uint8Array): Promise<TextFile> {
	const file = readTextFile(bytes)

	if (!readAsLegacy(file)) {
		return file
	}

	const guess = await guessLegacyEncoding(bytes, true)

	return guess === null || guess === file.encoding ? file : readTextFile(bytes, { guess })
}
