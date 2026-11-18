import { ENCODING_DETECT_WASM } from "virtual:encoding-detect"
import { EncodingDetector } from "@filen/encoding-detect"
import { textEncodingLabel } from "@filen/shared/textEncoding"
import { registerPreviewDisposer } from "@/lib/workers/previewDisposers"
import { log } from "@/lib/log"
import { readTextFile, readUnicodeTextFile, type TextFile } from "@/features/preview/lib/textFile"

// The legacy encoding detector (chardetng as wasm), loaded the first time a text file turns out not to be Unicode and
// kept for the session: its scratch region holds the head of the last file asked about, so sign-out drops it.
let detector: { readonly loading: Promise<EncodingDetector>; readonly unregister: () => void } | null = null

function load(): NonNullable<typeof detector> {
	const loading = WebAssembly.compileStreaming(fetch(ENCODING_DETECT_WASM)).then(module => EncodingDetector.instantiate(module))
	const unregister = registerPreviewDisposer("encodingDetector", () => {
		if (detector?.loading === loading) {
			detector = null
		}
	})

	return { loading, unregister }
}

// The legacy encoding (a TEXT_ENCODINGS label) the bytes most likely are, from up to a MiB around their first non-ASCII
// byte; ask only for bytes that are not Unicode (readUnicodeTextFile gave null). `last`: the bytes are the whole file.
// null when that holds no evidence (all ASCII) or the detector cannot load (the next ask loads it again), so the caller
// keeps the language's codepage.
export async function guessLegacyEncoding(bytes: Uint8Array, last: boolean): Promise<string | null> {
	const pending = (detector ??= load())

	try {
		const name = (await pending.loading).guess(bytes, last)

		return name === null ? null : textEncodingLabel(name)
	} catch (e) {
		if (detector === pending) {
			detector = null
			pending.unregister()
		}

		log.error("preview", "guessing a text file's encoding failed", e)

		return null
	}
}

// A text file read as Unicode, else with `preferred` (a codepage it is known to be in), else with the detector's guess:
// one decode each way.
export async function readTextFileDetected(bytes: Uint8Array, preferred?: string | null): Promise<TextFile> {
	const unicode = readUnicodeTextFile(bytes)

	if (unicode !== null) {
		return unicode
	}

	const label =
		preferred !== undefined && preferred !== null && !preferred.startsWith("utf-") ? preferred : await guessLegacyEncoding(bytes, true)

	return label === null ? readTextFile(bytes) : readTextFile(bytes, { encoding: label })
}
