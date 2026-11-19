import { useEffect, useState } from "react"
import { driveItemName } from "@filen/shared"
import type { SheetEncryptionRefusal, SheetFileKind, SheetOpened, SheetOpenResult } from "@filen/office/core/sheet"
import { type DriveItem } from "@/features/drive/lib/item"
import { extensionOf, itemTypeExtension } from "@/features/drive/lib/preview.logic"
import { usePreviewBytes } from "@/features/preview/hooks/usePreviewBytes"
import type { PasswordVerdict } from "@/features/preview/components/docxPasswordPrompt"
import { spreadsheetSaveFormat } from "@/features/spreadsheet/lib/fileKind"
import { openSheet } from "@/features/spreadsheet/lib/sheetHosts"
import { SheetEventRelay } from "@/features/spreadsheet/lib/sheetEvents"
import { withWorkbookDigit } from "@/features/spreadsheet/lib/sheetDigitWidth"
import { sheetKindOf } from "@/features/spreadsheet/lib/sheetKind"
import { log } from "@/lib/log"
import { type ErrorDTO } from "@/lib/sdk/errors"

// An open session, with its events from the moment it opened.
export interface SheetHandle extends SheetOpened {
	readonly events: SheetEventRelay
}

export type SheetSessionState =
	| { status: "pending" }
	| { status: "error"; dto: ErrorDTO; retry: () => void }
	| { status: "unreadable" }
	// A password-protected workbook refused without asking (rights-managed, an encryption Filen can't open, damaged).
	| { status: "refused"; reason: SheetEncryptionRefusal }
	// Waiting for its password: `verify` tries one in the worker, which keeps the key.
	| { status: "locked"; verify: (password: string, signal: AbortSignal) => Promise<PasswordVerdict> }
	// `id` names this session (a reopen is another). `unnamed`: the name does not say it is a spreadsheet, so its kind
	// was read from its bytes and it opens read-only. `renamed`: since renamed to another format's extension, which a
	// save would mislabel. `bytes`: the file as opened (the preview cache's buffer: read it, never transfer it).
	// `editAnyway`: the author recommends opening it read-only; this reopens it for editing.
	| {
			status: "ready"
			id: number
			handle: SheetHandle
			kind: SheetFileKind
			unnamed: boolean
			renamed: boolean
			bytes: Uint8Array
			editAnyway: (() => void) | undefined
			// The file has a password to modify and it was not given: this reopens it for editing once it is.
			modifyLocked: (() => void) | undefined
	  }

type Opened =
	| { status: "unreadable" }
	| { status: "refused"; reason: SheetEncryptionRefusal }
	| { status: "locked"; verify: (password: string, signal: AbortSignal) => Promise<PasswordVerdict> }
	| { status: "ready"; id: number; handle: SheetHandle; kind: SheetFileKind; unnamed: boolean; format: string | null }

let lastSession = 0

// Each opened session's id: the viewer keys what shows a session by it.
function newSessionId(): number {
	lastSession += 1

	return lastSession
}

// The log's ring keeps a non-string argument as its JSON, which is `{}` for an Error.
function errorText(error: unknown): unknown {
	return error instanceof Error ? error.message : error
}

function nameFormat(item: DriveItem): string | null {
	return spreadsheetSaveFormat(extensionOf(driveItemName(item)))
}

// Downloads the file (the preview's shared byte load and cache) and opens it in a sheet worker, closing it there
// when the viewer goes. The worker gets a copy. Opens once per `documentKey`: an item that changes under the same
// key (an own save rotating its uuid) keeps the open session, with its undo history.
export function useSheetSession(item: DriveItem, documentKey: string): SheetSessionState {
	const [pinned, setPinned] = useState({ key: documentKey, item })

	if (pinned.key !== documentKey) {
		setPinned({ key: documentKey, item })
	}

	const opening = pinned.key === documentKey ? pinned.item : item
	const bytes = usePreviewBytes(opening)
	const extension = extensionOf(driveItemName(opening))
	const typeSaysTsv = itemTypeExtension(opening) === "tsv"
	const format = nameFormat(opening)
	// The author's read-only recommendation, set aside by the user ("Edit anyway"): the file opens again for editing.
	const [writeUnlocked, setWriteUnlocked] = useState<{ source: Uint8Array; key: string } | null>(null)
	const [opened, setOpened] = useState<{ bytes: Uint8Array; writeUnlocked: boolean; state: Opened } | null>(null)
	const source = bytes.status === "success" ? bytes.bytes : null
	const unlockedWrite = writeUnlocked !== null && writeUnlocked.source === source && writeUnlocked.key === documentKey

	useEffect(() => {
		if (source === null) {
			return undefined
		}

		let live = true
		let close: (() => void) | null = null
		const file = source
		const { kind, unnamed } = sheetKindOf(extension, file, typeSaysTsv)
		const events = new SheetEventRelay()
		const leaving = new AbortController()

		function show(state: Opened): void {
			setOpened({ bytes: file, writeUnlocked: unlockedWrite, state })
		}

		// Shown once the workbook's digit width is measured and handed in (sheetDigitWidth.ts): the grid never lays
		// columns out in another unit first.
		function ready(result: SheetOpened): void {
			close = () => {
				result.session.close()
			}
			void withWorkbookDigit(result, events)
				.catch((error: unknown) => {
					// Closing the session (the user left) rejects the pending query: that is no failure.
					if (live) {
						log.warn("preview", "spreadsheet digit width failed", errorText(error))
					}

					return result
				})
				.then(measured => {
					if (live) {
						show({ status: "ready", id: newSessionId(), handle: { ...measured, events }, kind, unnamed, format })
					}
				})
		}

		async function verify(
			locked: Extract<SheetOpenResult, { kind: "needsPassword" }>["locked"],
			password: string,
			signal: AbortSignal
		) {
			const answer = await locked.unlock(password, { signal }).catch((error: unknown) => {
				log.warn("preview", "spreadsheet unlock failed", errorText(error))

				return null
			})

			if (!live) {
				if (answer?.ok === true) {
					answer.session.close()
				}

				return "aborted" as const
			}

			if (answer === null) {
				show({ status: "unreadable" })

				return "aborted" as const
			}

			if (answer.ok) {
				ready(answer)

				return "accepted" as const
			}

			switch (answer.reason) {
				case "wrongPassword":
					return "wrong" as const
				case "aborted":
					return "aborted" as const
				default:
					show({ status: "refused", reason: answer.reason })

					return "aborted" as const
			}
		}

		const copy = file.slice()

		openSheet(copy, { kind, writeUnlocked: unlockedWrite, signal: leaving.signal }, events.emit).then(
			result => {
				if (!live) {
					if (result.kind === "opened") {
						result.session.close()
					} else if (result.kind === "needsPassword") {
						result.locked.dispose()
					}

					return
				}

				switch (result.kind) {
					case "opened":
						ready(result)
						break
					case "needsPassword": {
						const locked = result.locked

						close = () => {
							locked.dispose()
						}
						show({
							status: "locked",
							verify: (password, signal) => verify(locked, password, signal)
						})
						break
					}
					case "refused":
						show({ status: "refused", reason: result.reason })
						break
					case "failed":
						// The worker's reason and message only: never the file's name or content.
						log.warn("preview", "spreadsheet open failed", result.reason, result.message)
						show({ status: "unreadable" })
						break
					case "aborted":
						show({ status: "unreadable" })
						break
				}
			},
			(error: unknown) => {
				if (live) {
					log.warn("preview", "spreadsheet open failed", errorText(error))
					show({ status: "unreadable" })
				}
			}
		)

		return () => {
			live = false
			leaving.abort()
			close?.()
		}
	}, [source, extension, typeSaysTsv, format, unlockedWrite])

	if (bytes.status === "error") {
		return { status: "error", dto: bytes.dto, retry: bytes.refetch }
	}

	// A state from an earlier buffer, or from before an "Edit anyway", is not this one's.
	if (opened?.bytes !== source || opened.writeUnlocked !== unlockedWrite) {
		return { status: "pending" }
	}

	if (opened.state.status !== "ready") {
		return opened.state
	}

	const { id, handle, kind, unnamed, format: openedAs } = opened.state
	const sharing = handle.info.fileSharing
	const editAnyway =
		!unlockedWrite && sharing?.readOnlyRecommended === true && !sharing.modifyPassword
			? () => {
					setWriteUnlocked({ source, key: documentKey })
				}
			: undefined
	// The file's password to modify was given (checked by menus/modifyPassword.tsx): reopened for editing.
	const modifyLocked =
		!unlockedWrite && sharing?.modifyPassword === true
			? () => {
					setWriteUnlocked({ source, key: documentKey })
				}
			: undefined

	return {
		status: "ready",
		id,
		handle,
		kind,
		unnamed,
		renamed: !unnamed && nameFormat(item) !== openedAs,
		bytes: opened.bytes,
		editAnyway,
		modifyLocked
	}
}
