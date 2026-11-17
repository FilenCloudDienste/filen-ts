import { useEffect, useState } from "react"
import { looksLikeText } from "@filen/shared/textEncoding"
import type { DriveItem } from "@/features/drive/lib/item"
import { usePreviewBytes, type UsePreviewBytesResult } from "@/features/preview/hooks/usePreviewBytes"
import { readAsLegacy, readTextFile, utf8Format, type TextFile } from "@/features/preview/lib/textFile"
import { guessLegacyEncoding } from "@/features/preview/lib/encodingGuess"

// The status bar's encoding menu: read the held bytes again with another encoding, or save them as UTF-8. Neither
// is remembered for the next open.
export interface TextEncodingControls {
	// What the file was read with before any choice.
	readonly detected: string
	// The encoding chosen with Reopen; null while the detected one stands.
	readonly chosen: string | null
	// Reads the held bytes again with `label` (a TEXT_ENCODINGS label), or as detected for null. Only while clean.
	readonly reopen: (label: string | null) => void
	// Saves the text as UTF-8 from now on; null where that is not offered (not editable here, UTF-8 as is already).
	readonly convert: (() => void) | null
	// Converted: the file differs from what is saved until the next save.
	readonly converted: boolean
}

export type PreviewTextFile =
	| Exclude<UsePreviewBytesResult, { status: "success" }>
	// The bytes do not look like text: nothing is decoded until the user asks to see them anyway, read-only.
	| { status: "notText"; showAnyway: () => void }
	// `writable`: a save writes back the bytes the file came from (or, converted, the same text as UTF-8).
	| { status: "success"; bytes: Uint8Array; file: TextFile; writable: boolean; encoding: TextEncodingControls }

// What an editable text viewer tells the overlay: whether a save writes the file back as it was (one it would change
// keeps the slot read-only until converted), and the encoding a save writes (a newer version is compared in it).
export interface TextState {
	readonly writable: boolean
	readonly encoding: string
}

// The whole-buffer load every text-family viewer opens on. Bytes that do not look like text (looksLikeText) are not
// decoded; once shown anyway they stay read-only. A file asked to be editable reports its TextState.
export function usePreviewTextFile(
	item: DriveItem,
	editable: boolean,
	onTextState: ((state: TextState) => void) | undefined
): PreviewTextFile {
	const result = usePreviewBytes(item)
	// The viewer is remounted per file, so none of these carry over to another.
	const [shownAnyway, setShownAnyway] = useState(false)
	// Reopened with `label`; `detected` is what the first read found.
	const [choice, setChoice] = useState<{ label: string; detected: string } | null>(null)
	const [converted, setConverted] = useState(false)
	// The detector's guess for these bytes (undefined: not asked yet; null: no guess).
	const [guess, setGuess] = useState<{ bytes: Uint8Array; label: string | null } | null>(null)
	const bytes = result.status === "success" ? result.bytes : null
	const known = guess !== null && guess.bytes === bytes ? guess.label : undefined
	const notText = bytes !== null && !looksLikeText(bytes)
	const read =
		bytes !== null && (!notText || shownAnyway) ? readTextFile(bytes, { encoding: choice?.label ?? null, guess: known ?? null }) : null
	// Not Unicode and not shown anyway: the detector (lazily loaded wasm, the first MiB) picks the codepage first.
	const guessing = read !== null && !notText && choice === null && known === undefined && readAsLegacy(read)

	useEffect(() => {
		if (!guessing || bytes === null) {
			return undefined
		}

		let live = true

		void guessLegacyEncoding(bytes, true).then(label => {
			if (live) {
				setGuess({ bytes, label })
			}
		})

		return () => {
			live = false
		}
	}, [guessing, bytes])
	const file = read !== null && converted ? { ...read, ...utf8Format(read), editableAsIs: true } : read
	const writable = file !== null && !notText && file.editableAsIs
	const reports = editable && file !== null && !guessing
	const encoding = file?.encoding ?? ""

	useEffect(() => {
		if (reports) {
			onTextState?.({ writable, encoding })
		}
	}, [reports, writable, encoding, onTextState])

	if (result.status !== "success") {
		return result
	}

	if (guessing) {
		return { status: "pending", refetch: result.refetch }
	}

	if (file === null || read === null) {
		return {
			status: "notText",
			showAnyway: () => {
				setShownAnyway(true)
			}
		}
	}

	const detected = choice?.detected ?? read.encoding

	return {
		status: "success",
		bytes: result.bytes,
		file,
		writable,
		encoding: {
			detected,
			chosen: choice?.label ?? null,
			reopen: label => {
				setChoice(label === null ? null : { label, detected })
				setConverted(false)
			},
			convert:
				editable && !notText && !converted && !(read.encoding === "utf-8" && read.editableAsIs)
					? () => {
							setConverted(true)
						}
					: null,
			converted
		}
	}
}
