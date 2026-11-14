import { useEffect, useRef, useState } from "react"
import {
	classifyPdfError,
	openPdf,
	type PdfErrorKind,
	type PdfJs,
	type PdfOpenOptions,
	type PdfOpening,
	type PdfAssets,
	type PdfPasswordReason,
	type PdfSource
} from "../../dom/pdf/index"
import type { PdfDomDocument } from "./types"

export type PdfDocumentState =
	| { readonly status: "loading" }
	// pdf.js waits for an answer through `password`.
	| { readonly status: "password"; readonly reason: PdfPasswordReason }
	| { readonly status: "ready"; readonly document: PdfDomDocument }
	| { readonly status: "error"; readonly kind: PdfErrorKind }

export type PdfDocumentOptions = Omit<PdfOpenOptions, "onPassword" | "onReadError" | "onFullyRead">

export interface PdfDocumentHandle {
	readonly state: PdfDocumentState
	readonly password: (password: string) => void
	// Opens the same source again after an error.
	readonly retry: () => void
	// pdf.js has read every byte of a ranged source and holds the whole file (a search of every page, printing, its
	// read-everything fallback for a damaged file).
	readonly fullyRead: boolean
	// Opens the same source again in the background, answering a password with the one accepted before, and swaps
	// the new document in once it is ready: the old one keeps showing meanwhile, and its memory goes with it.
	readonly reopen: () => void
	// The password pdf.js accepted for the document shown, null when none was asked (memory only: an editor taking over
	// opens the file with it). The same function for the hook's life: an effect handing it on does not run again on
	// every render.
	readonly acceptedPassword: () => string | null
	// Closes the document now (another engine took over its view); `state` stays as it was, never used again.
	readonly release: () => void
}

const LOADING = { status: "loading" } as const

function sameSource(a: PdfSource, b: PdfSource): boolean {
	if (a === b) return true
	if (a.kind === "bytes") return b.kind === "bytes" && a.bytes === b.bytes
	if (b.kind === "bytes") return false

	return a.read === b.read && a.length === b.length && a.maxRead === b.maxRead && a.chunkSize === b.chunkSize
}

function sameAssets(a: PdfAssets | undefined, b: PdfAssets | undefined): boolean {
	if (a === b) return true
	if (a === undefined || b === undefined || a.kind !== b.kind) return false
	if (a.kind === "inline" && b.kind === "inline") return a.read === b.read
	if (a.kind === "urls" && b.kind === "urls") {
		return (
			a.cMapUrl === b.cMapUrl && a.standardFontDataUrl === b.standardFontDataUrl && a.wasmUrl === b.wasmUrl && a.iccUrl === b.iccUrl
		)
	}

	return true
}

function sameOptions(a: PdfDocumentOptions, b: PdfDocumentOptions): boolean {
	return (
		a === b ||
		(a.worker.kind === b.worker.kind &&
			(a.worker.kind === "inThread" || (b.worker.kind === "script" && a.worker.src === b.worker.src)) &&
			sameAssets(a.assets, b.assets) &&
			a.maxImageSize === b.maxImageSize &&
			a.canvasMaxAreaInBytes === b.canvasMaxAreaInBytes)
	)
}

// One loading task's life: the password loop on the same task (a second getDocument would get a detached
// buffer; the task already holds the file in its worker), and teardown on unmount or a new source. A source or
// options equal to the previous ones (the same bytes, the same reader) keep the document open, however the
// host built them.
export function usePdfDocument(pdfjs: PdfJs<ReadableStream>, source: PdfSource, options: PdfDocumentOptions): PdfDocumentHandle {
	const [attempt, setAttempt] = useState(0)
	// Bumped by reopen(): the same source, opened again.
	const [generation, setGeneration] = useState(0)
	const [opened, setOpened] = useState({ source, options })
	// Tagged with what it belongs to, so a new source shows as loading from its first render on. A reopen keeps the
	// entry until the new document replaces it.
	const [entry, setEntry] = useState<{
		readonly source: PdfSource
		readonly attempt: number
		readonly state: PdfDocumentState
		readonly fullyRead: boolean
	} | null>(null)
	const openingRef = useRef<PdfOpening<ReadableStream> | null>(null)
	// The password last answered, and the one pdf.js accepted: a reopen answers with it (memory only, never kept
	// beyond this hook).
	const triedRef = useRef<string | null>(null)
	const acceptedRef = useRef<string | null>(null)
	const [acceptedPassword] = useState(() => () => acceptedRef.current)
	// Set by reopen() for the open effect's cleanup, which then keeps the shown document until the new one shows.
	const reopeningRef = useRef(false)
	const retiringRef = useRef<{ readonly opening: PdfOpening<ReadableStream>; readonly document: PdfDomDocument } | null>(null)
	const current = opened.source
	const currentOptions = opened.options

	if (!sameSource(current, source) || !sameOptions(currentOptions, options)) setOpened({ source, options })

	const tagged = entry !== null && entry.source === current && entry.attempt === attempt ? entry : null
	const state = tagged?.state ?? LOADING
	const shown = state.status === "ready" ? state.document : null

	useEffect(() => {
		let live = true
		let ready: PdfDomDocument | null = null
		const reopening = retiringRef.current !== null
		const set = (next: PdfDocumentState, fullyRead: boolean): void => {
			if (live) setEntry({ source: current, attempt, state: next, fullyRead })
		}

		if (!reopening) {
			acceptedRef.current = null
			triedRef.current = null
		}

		const opening = openPdf(pdfjs, current, {
			...currentOptions,
			onPassword: reason => {
				const accepted = acceptedRef.current

				if (reopening && reason === "required" && accepted !== null && opening.password(accepted)) return

				set({ status: "password", reason }, false)
			},
			onReadError: () => {
				set({ status: "error", kind: "transportFailed" }, false)
			},
			onFullyRead: () => {
				if (ready !== null) set({ status: "ready", document: ready }, true)
			}
		})

		openingRef.current = opening
		opening.promise.then(
			document => {
				ready = document
				acceptedRef.current = triedRef.current ?? acceptedRef.current
				set({ status: "ready", document }, false)
			},
			(error: unknown) => {
				const failure = classifyPdfError(error)

				if (failure.type !== "aborted") {
					set(
						failure.type === "password"
							? { status: "password", reason: failure.reason }
							: { status: "error", kind: failure.kind },
						false
					)
				}
			}
		)

		return () => {
			live = false
			openingRef.current = null

			if (reopeningRef.current && ready !== null) retiringRef.current = { opening, document: ready }
			else void opening.destroy()

			reopeningRef.current = false
		}
	}, [pdfjs, current, currentOptions, attempt, generation])

	// The document a reopen replaced goes once another one shows (or none does).
	useEffect(() => {
		const retiring = retiringRef.current

		if (retiring !== null && retiring.document !== shown) {
			retiringRef.current = null
			void retiring.opening.destroy()
		}
	}, [shown])

	useEffect(
		() => () => {
			const retiring = retiringRef.current

			retiringRef.current = null
			void retiring?.opening.destroy()
		},
		[]
	)

	return {
		state,
		fullyRead: tagged?.fullyRead ?? false,
		password: password => {
			triedRef.current = password

			if (openingRef.current?.password(password) === true) {
				setEntry({ source: current, attempt, state: LOADING, fullyRead: false })
			}
		},
		retry: () => {
			setAttempt(value => value + 1)
		},
		reopen: () => {
			if (state.status !== "ready" || retiringRef.current !== null || reopeningRef.current) return

			reopeningRef.current = true
			setGeneration(value => value + 1)
		},
		acceptedPassword,
		release: () => {
			const opening = openingRef.current

			openingRef.current = null
			void opening?.destroy()
		}
	}
}
