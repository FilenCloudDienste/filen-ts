import { useEffect, useEffectEvent, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { InfoIcon } from "lucide-react"
import { asErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"
import type { ByteOrigin } from "@/lib/sdk/byteOrigin"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { useDeviceProfile } from "@/lib/useDeviceProfile"
import type { DriveItem } from "@/features/drive/lib/item"
import { bufferedSizeCap, itemTypeExtension } from "@/features/drive/lib/preview.logic"
import { PreviewByteOriginProvider, usePreviewOrigin } from "@/features/preview/lib/accessMode"
import { ReadOnlyPreviewBody } from "@/features/preview/components/readOnlyPreviewBody"
import { PreviewErrorState, PreviewLoading, PreviewUnsupportedState } from "@/features/preview/components/previewErrorState"
import { acquireArchiveHandle, archiveHandleRefusal } from "@/features/archive/lib/archiveHandle"
import { archiveEntryItem } from "@/features/archive/lib/entryItem"
import { ArchiveWaiting, Banner } from "@/features/archive/components/archiveStatus"
import { openIworkPreview } from "@/features/iwork/lib/iworkPreview"
import { iworkAppFor, isUnreadablePackage, type IworkPreviewKind } from "@/features/iwork/lib/iworkPreview.logic"

type IworkState =
	| { readonly type: "empty" }
	| { readonly type: "failed"; readonly error: ErrorDTO }
	| { readonly type: "ready"; readonly origin: ByteOrigin; readonly entry: DriveItem; readonly kind: IworkPreviewKind }

// A Pages, Numbers or Keynote document, shown as the rendering of itself it carries (a first-page image, or an older
// document's PDF copy) under a note that this is only a preview. The package is listed and that one entry read, never
// the whole file. Stopped while it waits for another archive job, it offers to try again.
export function IworkPreview({ item, alt }: { item: DriveItem; alt: string }): ReactNode {
	const { t } = useTranslation("preview")
	const profile = useDeviceProfile()
	const origin = usePreviewOrigin(item)
	const uuid = item.data.uuid
	const [attempt, setAttempt] = useState(0)
	const [stopped, setStopped] = useState(false)
	const [waiting, setWaiting] = useState(false)
	// The outcome of the run `key` names; any other is still loading.
	const [outcome, setOutcome] = useState<{ key: string; state: IworkState } | null>(null)
	const key = `${uuid}:${String(attempt)}`
	const openFrom = useEffectEvent(() => origin)
	const onWaiting = useEffectEvent((next: boolean) => {
		setWaiting(next)
	})
	const settle = useEffectEvent((runKey: string, state: IworkState) => {
		setOutcome({ key: runKey, state })
	})

	useEffect(() => {
		if (stopped) {
			return
		}

		const runKey = `${uuid}:${String(attempt)}`
		const abort = new AbortController()
		const acquired = acquireArchiveHandle(openFrom(), undefined)

		// Rendered as its card below.
		if (acquired.type === "refused") {
			return
		}

		const { handle } = acquired
		const report = (next: boolean): void => {
			if (!abort.signal.aborted) {
				onWaiting(next)
			}
		}
		let release: (() => void) | null = null

		void openIworkPreview(handle, {
			signal: abort.signal,
			onWaiting: report,
			events: {
				phase: phase => {
					report(phase === "waitingForWorker")
				},
				verified: () => undefined,
				failed: () => undefined
			}
		}).then(
			opened => {
				// The view went in the gap before this ran: the lease is no one's.
				if (abort.signal.aborted) {
					opened?.lease.release()

					return
				}

				if (opened === null) {
					settle(runKey, { type: "empty" })

					return
				}

				release = opened.lease.release
				settle(runKey, {
					type: "ready",
					origin: opened.lease.origin,
					entry: archiveEntryItem(uuid, opened.index, opened.name, opened.size, opened.modified),
					kind: opened.kind
				})
			},
			(e: unknown) => {
				if (abort.signal.aborted) {
					return
				}

				const error = asErrorDTO(e)

				settle(runKey, isUnreadablePackage(error.kind) ? { type: "empty" } : { type: "failed", error })
			}
		)

		return () => {
			abort.abort()
			release?.()
			handle.release()
			onWaiting(false)
		}
	}, [uuid, attempt, stopped])

	const retry = (): void => {
		setStopped(false)
		setAttempt(previous => previous + 1)
	}

	// Its package cannot be opened from here yet (a public link's, or one inside an archive).
	if (archiveHandleRefusal(origin) !== null) {
		return (
			<PreviewUnsupportedState
				item={item}
				message={t("previewIworkUnavailableHere")}
			/>
		)
	}

	if (stopped) {
		return (
			<PreviewErrorState
				message={t("previewArchiveNotListed")}
				onRetry={retry}
			/>
		)
	}

	const waitingState = waiting ? (
		<div className="absolute inset-0 bg-background">
			<ArchiveWaiting
				onCancel={() => {
					setStopped(true)
				}}
			/>
		</div>
	) : null
	const state = outcome?.key === key ? outcome.state : null

	if (state === null) {
		return (
			<div className="relative size-full">
				<PreviewLoading />
				{waitingState}
			</div>
		)
	}

	switch (state.type) {
		case "empty":
			return (
				<PreviewUnsupportedState
					item={item}
					message={t("previewIworkNoPreview")}
				/>
			)
		case "failed":
			return (
				<PreviewErrorState
					message={errorLabel(state.error)}
					onRetry={retry}
				/>
			)
		case "ready":
			break
	}

	const category = state.kind === "pdf" ? "pdf" : "image"
	const cap = bufferedSizeCap(category, profile)

	if (cap !== null && state.entry.data.size > cap) {
		return (
			<PreviewUnsupportedState
				item={item}
				message={t("previewTooLargeToShowHere")}
			/>
		)
	}

	const app = iworkAppFor(itemTypeExtension(item)) ?? "iWork"

	return (
		<div className="flex size-full flex-col">
			<Banner
				tone="info"
				icon={<InfoIcon className="size-4 text-muted-foreground" />}
			>
				{state.kind === "pdf" ? t("previewIworkSavedCopy", { app }) : t("previewIworkFirstPageImage", { app })}
			</Banner>
			<div className="relative min-h-0 flex-1">
				<PreviewByteOriginProvider origin={state.origin}>
					<ReadOnlyPreviewBody
						item={state.entry}
						category={category}
						alt={alt}
					/>
				</PreviewByteOriginProvider>
				{waitingState}
			</div>
		</div>
	)
}
