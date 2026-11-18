import { useEffect, useRef, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { formatBytes } from "@filen/shared"
import { isFsaAvailable, canTransferStreams } from "@/features/drive/lib/saveDownload"
import { toastDownloadFailed } from "@/features/transfers/lib/settle"
import { asErrorDTO } from "@/lib/sdk/errors"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { entryAccessOf } from "@/features/archive/lib/archiveHandle"
import { nestedTarget } from "@/features/archive/lib/archiveReaders"
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
	entryReadPlan,
	extractsToRead,
	entryAwaitsSniff,
	entryPreviewCategory,
	holdsNestedArchive,
	isEncryptedEntry,
	needsCostConfirm,
	nestedOpening,
	type ExtractReason
} from "@/features/archive/lib/entryAccess.logic"
import { defaultEntryDownloadDeps, entryRequest, runEntryDownload } from "@/features/archive/lib/entryDownload"
import { nestedArchiveSource, type ArchiveSource } from "@/features/archive/lib/archiveSource"
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
	// Opens or saves it, confirming a solid block entry's cost first, once per listing session.
	request: (target: EntryTarget, intent: EntryIntent) => void
	// A double-click or Enter on a file: opened when it previews, else saved; false when neither applies.
	activate: (target: EntryTarget) => boolean
	offers: (target: EntryTarget) => EntryOffers
	// The cost confirms (a solid block's, an inner archive's inflate) and the password prompt of a download.
	dialogs: ReactNode
}

export interface EntryActionsInput {
	source: ArchiveSource
	session: () => ListingSession | null
	// A link allowing no downloads still previews.
	downloadable: boolean
	isOnline: boolean
	// Browses an archive held in an entry in this one's place (W6 §6.1 A); null where none is entered.
	onEnterArchive: ((inner: ArchiveSource) => void) | null
}

// A single entry previewed or saved from the archive browser. A selection of several never comes here: it
// extracts.
export function useEntryActions({ source, session, downloadable, isOnline, onEnterArchive }: EntryActionsInput): EntryActions {
	const { t } = useTranslation(["preview", "common"])
	const cacheScope = usePreviewCacheScope()
	const [viewing, setViewing] = useState<ViewedEntryState | null>(null)
	const [costAsk, setCostAsk] = useState<(EntryTarget & { intent: EntryIntent }) | null>(null)
	const [passwordAsk, setPasswordAsk] = useState<(EntryTarget & { wrong: boolean }) | null>(null)
	// An inner archive in a seekable entry above NESTED_INFLATE_CONFIRM_BYTES, waiting for its inflate to be confirmed.
	const [inflateAsk, setInflateAsk] = useState<{ inner: ArchiveSource; size: number } | null>(null)
	// The access question of the inner archive asked last: a newer one, or the browser going, cancels it.
	const entering = useRef<AbortController | null>(null)

	useEffect(
		() => () => {
			entering.current?.abort()
		},
		[]
	)

	// An archive held in the entry, opened in this one's place, no deeper than MAX_NESTED_DEPTH.
	function entersArchive({ store, slot }: EntryTarget): boolean {
		return onEnterArchive !== null && holdsNestedArchive(store, slot) && nestedTarget(source, undefined, store.index(slot)) !== null
	}

	function offers(target: EntryTarget): EntryOffers {
		const { store, slot } = target

		return {
			open: canOpenEntry(store, slot) || entersArchive(target),
			download: downloadable && isOnline && canReadEntry(store, slot)
		}
	}

	// The inner archive opens by its entry's access kind (W6 §3.10): in this one's place when it is mapped, or seekable
	// (its inflate confirmed above NESTED_INFLATE_CONFIRM_BYTES), else as the "Extract to open" card.
	function enterArchive(target: EntryTarget): void {
		const password = session()?.password()
		const inner = nestedArchiveSource(source, password, target.store, target.slot)

		if (inner === null || onEnterArchive === null) {
			return
		}

		const controller = new AbortController()

		entering.current?.abort()
		entering.current = controller
		void entryAccessOf(source, password, target.store.index(target.slot), controller.signal).then(
			access => {
				if (controller.signal.aborted) {
					return
				}

				switch (nestedOpening(access, inner.size)) {
					case "enter":
						onEnterArchive(inner)

						break
					case "confirm":
						setInflateAsk({ inner, size: inner.size })

						break
					case "extract":
						open(target, "open")

						break
				}
			},
			(e: unknown) => {
				if (!controller.signal.aborted) {
					toast.error(errorLabel(asErrorDTO(e)))
				}
			}
		)
	}

	// `extract`: it is not read from here (a block too large, E3), so it opens as the card offering to extract.
	function open({ store, slot }: EntryTarget, extract?: ExtractReason): void {
		const request = entryRequest(source, store, slot)
		// Its content read picks the viewer once it opens.
		const awaitsSniff = entryAwaitsSniff(store, slot)
		const category = awaitsSniff ? null : entryPreviewCategory(store.name(slot))

		// A card shows whatever the entry is; a viewer needs a kind to show it in.
		if (request === null || (category === null && !awaitsSniff && extract === undefined)) {
			return
		}

		setViewing({
			store,
			slot,
			entry: { request, category, modified: store.modified(slot), encrypted: isEncryptedEntry(store, slot), extract },
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

		// A solid block above E3's ceiling: no cost covers reading it from here. Opened, its card offers the extract.
		if (extractsToRead(target.store, target.slot)) {
			if (intent === "open") {
				open(target, "read")
			} else {
				toast.error(t("previewArchiveEntryExtractToRead", { name: target.store.name(target.slot) }))
			}

			return
		}

		// An inner archive costs no solid read to open: one in a solid block reads only whole, so it shows its card.
		if (intent === "open" && !canOpenEntry(target.store, target.slot) && entersArchive(target)) {
			enterArchive(target)

			return
		}

		// Bytes already held cost nothing to show again; once the session accepted a cost, its later entries are asked
		// no more (each stays bounded by its own listed skip).
		const held = intent === "open" && getPreviewBytes(cacheScope, entryKey(source.uuid, target.store.index(target.slot))) !== undefined

		if (!held && session()?.costAccepted() !== true && needsCostConfirm(target.store, target.slot)) {
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

	// What the read after a yes fetches: an open reads the block's next files ahead with it (the session will have
	// accepted a cost), a save the entry alone.
	const cost =
		costAsk === null
			? null
			: entryCost(
					costAsk.store,
					costAsk.slot,
					costAsk.intent === "open" ? entryReadPlan(costAsk.store, costAsk.slot, true) : undefined
				)

	const dialogs = (
		<>
			<ConfirmDialog
				open={costAsk !== null}
				pending={false}
				title={t("previewArchiveEntryCostTitle")}
				body={
					costAsk === null || cost === null
						? ""
						: t(costAsk.intent === "open" ? "previewArchiveEntryCostOnceOpenBody" : "previewArchiveEntryCostOnceDownloadBody", {
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
						session()?.acceptCost()
						run(costAsk, costAsk.intent)
					}
				}}
			/>
			<ConfirmDialog
				open={inflateAsk !== null}
				pending={false}
				title={t("previewArchiveNestedInflateTitle")}
				body={
					inflateAsk === null
						? ""
						: t("previewArchiveNestedInflateBody", { name: inflateAsk.inner.name, size: formatBytes(inflateAsk.size) })
				}
				confirmLabel={t("previewArchiveNestedInflateOpen")}
				cancelLabel={t("common:cancel")}
				onOpenChange={next => {
					if (!next) {
						setInflateAsk(null)
					}
				}}
				onConfirm={() => {
					if (inflateAsk !== null) {
						setInflateAsk(null)
						onEnterArchive?.(inflateAsk.inner)
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
