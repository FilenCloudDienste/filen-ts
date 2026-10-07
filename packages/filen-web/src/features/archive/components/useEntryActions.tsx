import { useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { formatBytes } from "@filen/shared"
import { isFsaAvailable, canTransferStreams } from "@/features/drive/lib/saveDownload"
import { toastDownloadFailed } from "@/features/transfers/lib/settle"
import { usePreviewCacheScope } from "@/features/preview/lib/accessMode"
import { getPreviewBytes } from "@/features/preview/lib/previewCache"
import type { EntryStore } from "@/features/archive/lib/entryStore"
import type { ListingSession } from "@/features/archive/lib/listingSession"
import type { EntryOffers } from "@/features/archive/lib/entryMenu"
import {
	canOpenEntry,
	canReadEntry,
	entryCost,
	entryKey,
	entryPreviewCategory,
	isEncryptedEntry,
	needsCostConfirm
} from "@/features/archive/lib/entryAccess.logic"
import { defaultEntryDownloadDeps, entryRequest, runEntryDownload } from "@/features/archive/lib/entryDownload"
import type { ArchiveSource } from "@/features/archive/lib/archiveSource"
import type { ViewedEntry } from "@/features/archive/components/archiveEntryViewer"
import { ArchivePasswordPrompt } from "@/features/archive/components/archivePasswordPrompt"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"

// An entry of the store it was listed in: a new listing run lists into a new store, where the slot means
// another entry.
export interface EntryTarget {
	store: EntryStore
	slot: number
}

export type EntryIntent = "open" | "download"

export interface ViewedEntryState extends EntryTarget {
	entry: ViewedEntry
	// The listing's password when it opened.
	password: string | undefined
}

export interface EntryActions {
	viewing: ViewedEntryState | null
	closeViewer: () => void
	// Opens or saves it, confirming a solid 7z entry's cost first.
	request: (target: EntryTarget, intent: EntryIntent) => void
	// A double-click or Enter on a file: opened when it previews, else saved; false when neither applies.
	activate: (target: EntryTarget) => boolean
	offers: (target: EntryTarget) => EntryOffers
	// The cost confirm and the password prompt of a download.
	dialogs: ReactNode
}

export interface EntryActionsInput {
	source: ArchiveSource
	session: () => ListingSession | null
	// A link allowing no downloads still previews.
	downloadable: boolean
	isOnline: boolean
}

// A single entry previewed or saved from the archive browser. A selection of several never comes here: it
// extracts.
export function useEntryActions({ source, session, downloadable, isOnline }: EntryActionsInput): EntryActions {
	const { t } = useTranslation(["preview", "common"])
	const cacheScope = usePreviewCacheScope()
	const [viewing, setViewing] = useState<ViewedEntryState | null>(null)
	const [costAsk, setCostAsk] = useState<(EntryTarget & { intent: EntryIntent }) | null>(null)
	const [passwordAsk, setPasswordAsk] = useState<(EntryTarget & { wrong: boolean }) | null>(null)

	function offers({ store, slot }: EntryTarget): EntryOffers {
		return { open: canOpenEntry(store, slot), download: downloadable && isOnline && canReadEntry(store, slot) }
	}

	function open({ store, slot }: EntryTarget): void {
		const request = entryRequest(source, store, slot)
		const category = entryPreviewCategory(store.name(slot))

		if (request === null || category === null) {
			return
		}

		setViewing({
			store,
			slot,
			entry: { request, category, modified: store.modified(slot), encrypted: isEncryptedEntry(store, slot) },
			password: session()?.password()
		})
	}

	// Runs inside the gesture that asked for it: the save picker needs one.
	function download(target: EntryTarget, password: string | undefined): void {
		const request = entryRequest(source, target.store, target.slot)

		if (request === null) {
			return
		}

		// Asked before the picker, so a password typed in is never followed by a file left empty.
		if (password === undefined && isEncryptedEntry(target.store, target.slot)) {
			setPasswordAsk({ ...target, wrong: false })

			return
		}

		void runEntryDownload(defaultEntryDownloadDeps, {
			request,
			password,
			onVerified: () => {
				if (password !== undefined) {
					session()?.acceptPassword(password)
				}
			}
		}).then(outcome => {
			if (outcome.status === "password") {
				setPasswordAsk({ ...target, wrong: outcome.wrong })
			} else if (outcome.status === "error") {
				toastDownloadFailed(outcome)
			}
		})
	}

	function run(target: EntryTarget, intent: EntryIntent): void {
		if (intent === "open") {
			open(target)
		} else {
			download(target, session()?.password())
		}
	}

	function request(target: EntryTarget, intent: EntryIntent): void {
		if (intent === "download" && !isFsaAvailable() && !canTransferStreams()) {
			toast.error(t("previewArchiveEntryDownloadUnsupported"))

			return
		}

		// Bytes already held cost nothing to show again.
		const held = intent === "open" && getPreviewBytes(cacheScope, entryKey(source.uuid, target.store.index(target.slot))) !== undefined

		if (!held && needsCostConfirm(target.store, target.slot)) {
			setCostAsk({ ...target, intent })

			return
		}

		run(target, intent)
	}

	function activate(target: EntryTarget): boolean {
		const offered = offers(target)

		if (!offered.open && !offered.download) {
			return false
		}

		request(target, offered.open ? "open" : "download")

		return true
	}

	const cost = costAsk === null ? null : entryCost(costAsk.store, costAsk.slot)

	const dialogs = (
		<>
			<ConfirmDialog
				open={costAsk !== null}
				pending={false}
				title={t("previewArchiveEntryCostTitle")}
				body={
					costAsk === null || cost === null
						? ""
						: t(costAsk.intent === "open" ? "previewArchiveEntryCostOpenBody" : "previewArchiveEntryCostDownloadBody", {
								name: costAsk.store.name(costAsk.slot),
								download: formatBytes(cost.estimatedBytes),
								skipped: formatBytes(cost.skippedBytes)
							})
				}
				confirmLabel={t(costAsk?.intent === "download" ? "previewArchiveEntryCostDownload" : "previewArchiveEntryCostOpen")}
				cancelLabel={t("common:cancel")}
				onOpenChange={next => {
					if (!next) {
						setCostAsk(null)
					}
				}}
				onConfirm={() => {
					if (costAsk !== null) {
						setCostAsk(null)
						run(costAsk, costAsk.intent)
					}
				}}
			/>
			<ArchivePasswordPrompt
				open={passwordAsk !== null}
				name={passwordAsk === null ? "" : passwordAsk.store.name(passwordAsk.slot)}
				wrong={passwordAsk?.wrong ?? false}
				onOpenChange={next => {
					if (!next) {
						setPasswordAsk(null)
					}
				}}
				onSubmit={password => {
					if (passwordAsk !== null) {
						setPasswordAsk(null)
						download(passwordAsk, password)
					}
				}}
			/>
		</>
	)

	return {
		viewing,
		closeViewer: () => {
			setViewing(null)
		},
		request,
		activate,
		offers,
		dialogs
	}
}
