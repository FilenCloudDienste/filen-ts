import { useEffect, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { HourglassIcon, InfoIcon, LockIcon, TriangleAlertIcon } from "lucide-react"
import { cn, formatBytes, formatBytesPerSecond, formatSecondsToMediaClock } from "@filen/shared"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { useDriveJobsStore } from "@/features/transfers/store/useDriveJobsStore"
import { pausedSlotHolder } from "@/features/archive/lib/slot"
import { failureLabelKey } from "@/features/archive/lib/archiveBrowser.logic"
import type { ListingPhase, ListSummary } from "@/features/archive/lib/listingSession"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"

// Renders `children` only once `ms` passed since it mounted: a state that ends quickly never flashes.
export function Delayed({ ms, children }: { ms: number; children: ReactNode }) {
	const [shown, setShown] = useState(false)

	useEffect(() => {
		const timer = setTimeout(() => {
			setShown(true)
		}, ms)

		return () => {
			clearTimeout(timer)
		}
	}, [ms])

	return shown ? children : null
}

// A paused job keeps the page's one archive slot and never frees it by itself.
function PausedHolderHint() {
	const { t } = useTranslation("preview")
	const pausedHolder = useDriveJobsStore(state => pausedSlotHolder(Object.values(state.jobs)) !== null)

	return pausedHolder ? <p className="text-sm text-muted-foreground">{t("previewArchiveWaitingPaused")}</p> : null
}

// Another archive job holds the page's one slot.
export function ArchiveWaiting({ onCancel }: { onCancel: () => void }) {
	const { t } = useTranslation(["preview", "common"])

	return (
		<div className="flex size-full flex-col items-center justify-center gap-3 px-6 text-center">
			<HourglassIcon
				aria-hidden="true"
				className="size-8 text-muted-foreground"
			/>
			<p className="text-sm">{t("previewArchiveWaiting")}</p>
			<PausedHolderHint />
			<Button
				variant="outline"
				onClick={onCancel}
			>
				{t("common:cancel")}
			</Button>
		</div>
	)
}

function Banner({
	tone,
	icon,
	children,
	action
}: {
	tone: "info" | "warning" | "error"
	icon: ReactNode
	children: ReactNode
	action?: ReactNode
}) {
	return (
		<div
			className={cn(
				"flex min-h-9 shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-sm",
				tone === "error" && "text-destructive",
				tone === "warning" && "bg-amber-500/10"
			)}
		>
			<span className="flex shrink-0">{icon}</span>
			<div className="min-w-0 flex-1">{children}</div>
			{action}
		</div>
	)
}

export interface ArchiveReadingProps {
	phase: Extract<ListingPhase, { type: "reading" }>
	// A tar's or single file's listing reads it all, which a byte bar shows; a zip's index read doesn't.
	wholeArchive: boolean
	onStop: () => void
}

export function ArchiveReading({ phase, wholeArchive, onStop }: ArchiveReadingProps) {
	const { t } = useTranslation("preview")
	const percent = wholeArchive && phase.archiveBytes > 0 ? Math.min((phase.bytesRead / phase.archiveBytes) * 100, 100) : null
	const parts = [
		t("previewArchiveEntryCount", { count: phase.entries }),
		percent === null
			? null
			: t("previewArchiveReadingBytes", { read: formatBytes(phase.bytesRead), total: formatBytes(phase.archiveBytes) }),
		phase.bytesPerSecond === null || percent === null ? null : formatBytesPerSecond(phase.bytesPerSecond),
		phase.etaMs === null || percent === null
			? null
			: t("previewArchiveEta", { eta: formatSecondsToMediaClock(Math.ceil(phase.etaMs / 1000)) })
	]
		.filter(part => part !== null)
		.join(" · ")

	return (
		<div className="flex shrink-0 flex-col gap-1.5 border-b border-border px-3 py-2 text-sm">
			<div className="flex items-center gap-2">
				<Spinner className="size-3.5 text-muted-foreground" />
				<span className="min-w-0 flex-1 truncate">
					{t("previewArchiveReading")} <span className="text-xs text-muted-foreground tabular-nums">{parts}</span>
				</span>
				<Button
					variant="outline"
					size="xs"
					onClick={onStop}
				>
					{t("previewArchiveStop")}
				</Button>
			</div>
			<Progress
				value={percent}
				aria-label={t("previewArchiveReading")}
			/>
		</div>
	)
}

export interface ArchiveStatusProps {
	phase: ListingPhase
	summary: ListSummary | null
	// Entries on the page.
	entries: number
	onListAgain: () => void
	onEnterPassword: () => void
	// Stops a password check.
	onCancelCheck: () => void
}

// What the list above it can't say: a stopped or failed listing, an encrypted part, entries that never
// reached the page, duplicate paths.
export function ArchiveStatus({ phase, summary, entries, onListAgain, onEnterPassword, onCancelCheck }: ArchiveStatusProps) {
	const { t } = useTranslation(["preview", "common"])
	const failureKey = phase.type === "failed" ? failureLabelKey(phase.error) : null
	const duplicates = summary?.duplicates ?? null

	return (
		<>
			{phase.type === "stopped" ? (
				<Banner
					tone="info"
					icon={<InfoIcon className="size-4 text-muted-foreground" />}
					action={
						<Button
							variant="outline"
							size="xs"
							onClick={onListAgain}
						>
							{t("previewArchiveListAgain")}
						</Button>
					}
				>
					{t("previewArchiveStopped", { count: entries })}
				</Banner>
			) : null}
			{phase.type === "failed" ? (
				<Banner
					tone="error"
					icon={<TriangleAlertIcon className="size-4" />}
					action={
						<Button
							variant="outline"
							size="xs"
							onClick={onListAgain}
						>
							{t("common:tryAgain")}
						</Button>
					}
				>
					{failureKey === null ? errorLabel(phase.error) : t(failureKey)}
					{entries > 0 ? <span className="text-muted-foreground"> {t("previewArchivePartial", { count: entries })}</span> : null}
				</Banner>
			) : null}
			{summary === null ? null : summary.verifying ? (
				<Banner
					tone="info"
					icon={<Spinner className="size-4 text-muted-foreground" />}
					action={
						<Button
							variant="outline"
							size="xs"
							onClick={onCancelCheck}
						>
							{t("common:cancel")}
						</Button>
					}
				>
					{summary.verifyWaiting ? (
						<>
							{t("previewArchiveCheckingPasswordWaiting")}
							<PausedHolderHint />
						</>
					) : (
						t("previewArchiveCheckingPassword")
					)}
				</Banner>
			) : summary.verifyError !== null ? (
				<Banner
					tone="error"
					icon={<TriangleAlertIcon className="size-4" />}
					action={
						<Button
							variant="outline"
							size="xs"
							onClick={onEnterPassword}
						>
							{t("common:tryAgain")}
						</Button>
					}
				>
					{errorLabel(summary.verifyError)}
				</Banner>
			) : summary.password === "required" || summary.password === "wrong" ? (
				<Banner
					tone="warning"
					icon={<LockIcon className="size-4 text-muted-foreground" />}
					action={
						<Button
							variant="outline"
							size="xs"
							onClick={onEnterPassword}
						>
							{t(summary.password === "wrong" ? "common:tryAgain" : "previewArchiveEnterPassword")}
						</Button>
					}
				>
					{t(summary.password === "wrong" ? "previewArchiveWrongPasswordBanner" : "previewArchiveEncryptedBanner")}
				</Banner>
			) : null}
			{summary !== null && summary.undelivered > 0 ? (
				<Banner
					tone="info"
					icon={<InfoIcon className="size-4 text-muted-foreground" />}
				>
					{t("previewArchiveUndelivered", { count: summary.undelivered })}
				</Banner>
			) : null}
			{duplicates !== null && duplicates.count > 0 ? (
				<Banner
					tone="info"
					icon={<InfoIcon className="size-4 text-muted-foreground" />}
				>
					<details>
						<summary className="cursor-pointer">{t("previewArchiveDuplicates", { count: duplicates.count })}</summary>
						<ul className="mt-1 max-h-32 overflow-y-auto text-xs text-muted-foreground select-text">
							{duplicates.names.slice(0, 100).map(name => (
								<li
									key={name}
									className="truncate"
								>
									{name}
								</li>
							))}
						</ul>
					</details>
				</Banner>
			) : null}
		</>
	)
}
