import { useEffect, useEffectEvent, useState } from "react"
import * as Comlink from "comlink"
import { legacyEncodingForLanguage } from "@filen/shared/textEncoding"
import { type DriveItem } from "@/features/drive/lib/item"
import { usePreviewAccessMode, usePreviewOrigin } from "@/features/preview/lib/accessMode"
import { openOriginPorts } from "@/features/preview/lib/origin/rangeSource"
import { guessLegacyEncoding } from "@/features/preview/lib/encodingGuess"
import { originKey, originSize } from "@/lib/sdk/byteOrigin"
import { asErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"
import { useOwnedWorker, type OwnedWorker } from "@/lib/workers/ownedWorker"
import TextPagerWorker from "@/features/preview/workers/textPager.worker.ts?worker"
import type { PagerOpen, TextPagerWorkerApi } from "@/features/preview/workers/textPager.worker"

export type TextPager = OwnedWorker<TextPagerWorkerApi>

export interface TextPagerReading {
	readonly pager: TextPager
	readonly size: number
	// Where the text starts (past a byte order mark).
	readonly start: number
	// What the file was read with first, and what it is read with now.
	readonly detected: string
	readonly label: string
	// Reads it again as `label` (a TEXT_ENCODINGS label), or as detected for null.
	readonly reopen: (label: string | null) => void
	// A read that failed (a lost port): the viewer shows the error state.
	readonly fail: (error: unknown) => void
}

export type TextPagerSession =
	| { readonly status: "pending" }
	| { readonly status: "error"; readonly dto: ErrorDTO; readonly retry: () => void }
	// Not text by its first bytes: shown only when asked (an executable shows as one).
	| { readonly status: "notText"; readonly executable: boolean; readonly showAnyway: () => void }
	| { readonly status: "ready"; readonly reading: TextPagerReading }

function createTextPagerWorker(): Worker {
	return new TextPagerWorker()
}

function isCancellation(error: unknown): boolean {
	return error instanceof DOMException && error.name === "AbortError"
}

// One large text file's pager worker over a range port on its origin (usePreviewOrigin: the session's or a public
// link's client, or a provided origin), under a token the preview's cancel registry ends. Unmounting closes the port
// (its reads in flight end), cancels the token and terminates the worker. A lost port or a broken worker turns into the
// error state, whose retry opens both again. Keyed on the origin's content, like usePreviewRangeSource.
// `textOnly: false`: a file whose head is not text is read anyway (a mailbox's binary parts are no reason to refuse it).
export function useTextPagerSession(item: DriveItem, options?: { readonly textOnly?: boolean }): TextPagerSession {
	const textOnly = options?.textOnly ?? true
	const origin = usePreviewOrigin(item)
	const access = usePreviewAccessMode()
	const size = originSize(origin)
	const [attempt, setAttempt] = useState(0)
	const key = `${origin.kind}:${originKey(origin)}:${String(size)}:${String(attempt)}`
	const worker = useOwnedWorker<TextPagerWorkerApi>(createTextPagerWorker, key, "text-pager")
	const owned = worker.status === "ready" ? worker.owned : null
	const generation = worker.status === "ready" ? worker.generation : 0
	const [opened, setOpened] = useState<{ readonly generation: number; readonly value: PagerOpen } | null>(null)
	const [failure, setFailure] = useState<{ readonly generation: number; readonly dto: ErrorDTO } | null>(null)
	const [shownAnyway, setShownAnyway] = useState<number | null>(null)
	const [chosen, setChosen] = useState<{ readonly generation: number; readonly label: string | null }>({ generation: 0, label: null })
	const [detected, setDetected] = useState<{ readonly generation: number; readonly label: string } | null>(null)
	const [reading, setReading] = useState<{
		readonly generation: number
		readonly detected: string
		readonly label: string
		readonly start: number
	} | null>(null)
	const latestOrigin = useEffectEvent(() => origin)
	const fail = (error: unknown): void => {
		if (!isCancellation(error)) {
			setFailure({ generation, dto: asErrorDTO(error) })
		}
	}
	const failOpen = useEffectEvent(fail)
	const open = opened?.generation === generation ? opened.value : null
	const label = chosen.generation === generation ? chosen.label : null
	const readable = open !== null && (open.text || !textOnly || shownAnyway === generation)

	useEffect(() => {
		if (owned === null) {
			return
		}

		const token = crypto.randomUUID()
		let live = true
		const alive = (): boolean => live
		// Ports only: the worker reads through the one it takes, and the page reads nothing itself.
		const ports = openOriginPorts(latestOrigin(), token, { access })

		void ports
			.port()
			.then(async port => {
				const lost = Comlink.proxy(() => {
					if (alive()) failOpen(new Error("range port lost"))
				})
				const value = await owned.run(remote => remote.open(Comlink.transfer(port, [port]), ports.size, lost))

				if (alive()) setOpened({ generation, value })
			})
			.catch((error: unknown) => {
				if (alive()) failOpen(error)
			})

		return () => {
			live = false
			// Ends every read still served on the port, the port itself and the token.
			ports.close()
		}
	}, [owned, generation, access])

	// The encoding the file reads as, once: its first block's copy (a legacy file's, for the guess) is dropped after.
	useEffect(() => {
		if (owned === null || open === null || !readable || detected?.generation === generation) {
			return
		}

		let live = true
		const { unicode, head } = open
		const detect = async (): Promise<string> =>
			unicode ??
			(head === null ? null : await guessLegacyEncoding(head, head.length >= size)) ??
			legacyEncodingForLanguage(navigator.languages[0] ?? null)

		void detect().then(
			found => {
				if (!live) {
					return
				}

				setDetected({ generation, label: found })
				setOpened(previous => (previous === null ? previous : { ...previous, value: { ...previous.value, head: null } }))
			},
			(error: unknown) => {
				if (live) failOpen(error)
			}
		)

		return () => {
			live = false
		}
	}, [owned, generation, open, readable, detected, size])

	const detectedLabel = detected?.generation === generation ? detected.label : null

	useEffect(() => {
		if (owned === null || detectedLabel === null) {
			return
		}

		let live = true
		const use = label ?? detectedLabel

		void owned
			.run(remote => remote.use(use))
			.then(
				({ start }) => {
					if (live) setReading({ generation, detected: detectedLabel, label: use, start })
				},
				(error: unknown) => {
					if (live) failOpen(error)
				}
			)

		return () => {
			live = false
		}
	}, [owned, generation, detectedLabel, label])

	if (worker.status === "failed") {
		return { status: "error", dto: worker.dto, retry: worker.restart }
	}

	if (failure?.generation === generation && owned !== null) {
		return {
			status: "error",
			dto: failure.dto,
			retry: () => {
				setAttempt(previous => previous + 1)
			}
		}
	}

	if (open !== null && !readable) {
		return {
			status: "notText",
			executable: open.executable,
			showAnyway: () => {
				setShownAnyway(generation)
			}
		}
	}

	if (owned === null || reading?.generation !== generation || (label !== null && reading.label !== label)) {
		return { status: "pending" }
	}

	return {
		status: "ready",
		reading: {
			pager: owned,
			size,
			start: reading.start,
			detected: reading.detected,
			label: reading.label,
			reopen: next => {
				setChosen({ generation, label: next })
			},
			fail
		}
	}
}
