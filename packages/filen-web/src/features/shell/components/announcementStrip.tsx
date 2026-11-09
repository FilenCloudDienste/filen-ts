import { useTranslation } from "react-i18next"
import { useQueryClient } from "@tanstack/react-query"
import { InfoIcon, TriangleAlertIcon, XIcon } from "lucide-react"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"
import { desktopBridge } from "@/lib/desktop"
import {
	currentAnnouncement,
	dismissAnnouncement,
	platformAnnouncements,
	selectAnnouncements,
	selectMaintenance,
	useDismissedAnnouncementsQuery,
	useRemoteConfigQuery,
	type AnnouncementPlatform
} from "@/features/settings/lib/remoteConfig"
import { cn } from "@filen/shared"

// The bridge never appears or disappears mid-session.
const PLATFORM: AnnouncementPlatform = desktopBridge() === undefined ? "web" : "desktop"

// A slim row above the shell's main row: the maintenance warning while the service reports it, else the newest active
// announcement for this platform the user has not dismissed. Renders nothing otherwise. Mounted only in the authed
// shell, so public-link pages never fetch the config.
export function AnnouncementStrip() {
	const { t } = useTranslation("settings")
	const client = useQueryClient()
	const maintenance = useRemoteConfigQuery(selectMaintenance).data === true
	const announcements = useRemoteConfigQuery(selectAnnouncements).data ?? []
	const candidates = platformAnnouncements(announcements, PLATFORM)
	const dismissedQuery = useDismissedAnnouncementsQuery(!maintenance && candidates.length > 0)

	if (maintenance) {
		return (
			<StripFrame
				tone="warning"
				label={t("maintenanceTitle")}
				title={t("maintenanceTitle")}
				message={t("maintenanceInfo")}
			/>
		)
	}

	// Waits for the dismissed list, so a dismissed announcement never flashes in while it loads.
	if (dismissedQuery.data === undefined) {
		return null
	}

	const announcement = currentAnnouncement(candidates, dismissedQuery.data)

	if (announcement === undefined) {
		return null
	}

	return (
		<StripFrame
			tone="info"
			label={t("announcementRegionLabel")}
			title={announcement.title}
			message={announcement.message}
			dismissLabel={t("announcementDismiss")}
			onDismiss={() => {
				void dismissAnnouncement(client, announcement.uuid, announcements)
			}}
		/>
	)
}

// Title and message render as text nodes only: they are remote and never interpreted as markup.
function StripFrame(props: {
	tone: "info" | "warning"
	label: string
	title: string
	message: string
	dismissLabel?: string
	onDismiss?: () => void
}) {
	const Icon = props.tone === "warning" ? TriangleAlertIcon : InfoIcon

	return (
		// The outer row is window chrome on desktop (drags the window, the button stays clickable); on macOS it leaves
		// the traffic lights' corner free.
		<div className="flex shrink-0 ps-[max(0.5rem,var(--window-inset-left))] pe-2 pt-2 app-region-chrome">
			<section
				role="status"
				aria-label={props.label}
				className={cn(
					"flex min-w-0 flex-1 items-start gap-2.5 rounded-xl px-3.5 py-2 text-sm ring-1",
					props.tone === "warning"
						? "bg-warning/12 text-warning-foreground ring-warning/25"
						: "bg-card text-foreground ring-shell-border"
				)}
			>
				<Icon
					aria-hidden="true"
					className={cn("mt-0.5 size-4 shrink-0", props.tone === "info" && "text-muted-foreground")}
				/>
				<div className="flex min-w-0 flex-1 flex-col gap-0.5 break-words">
					{props.title === "" ? null : <p className="font-medium">{props.title}</p>}
					{props.message === "" ? null : <p className={cn(props.title !== "" && "opacity-85")}>{props.message}</p>}
				</div>
				{props.onDismiss === undefined || props.dismissLabel === undefined ? null : (
					<TooltipIconButton
						label={props.dismissLabel}
						className="-my-1 -me-2 shrink-0"
						onClick={props.onDismiss}
					>
						<XIcon />
					</TooltipIconButton>
				)}
			</section>
		</div>
	)
}
