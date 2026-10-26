import { useTranslation } from "react-i18next"
import { Link } from "@tanstack/react-router"
import { HardDriveIcon, ServerIcon } from "lucide-react"
import { cn } from "@filen/shared"
import { Button } from "@/components/ui/button"
import { ResizableSidebarPanel } from "@/features/shell/components/sidebarPanel"
import { GROUP_HEADER_CLASS, SIDEBAR_NAV_ITEM_CLASS } from "@/features/shell/lib/sidebarNavItem"
import { hostBanner } from "@/features/desktop/lib/hostBanner.logic"
import { DesktopCallout } from "@/features/desktop/components/desktopCallout"
import { offeredProtocols, PROTOCOL_LABEL_KEY, type MountsRole } from "@/features/mounts/lib/mountsRoles"
import { mountsApi, useMountsHost, useMountsRoleState, useMountsStore } from "@/features/mounts/lib/mountsStore"
import { roleStateKey } from "@/features/mounts/lib/mountsStatus.logic"
import { desktopPlatform } from "@/lib/desktop"

// The platform never changes mid-session.
const PROTOCOLS = offeredProtocols(desktopPlatform())

// What the native host (shared with sync) is doing when that matters here: only while a mount or server is wanted.
function HostBanner() {
	const { t } = useTranslation("mounts")
	const host = useMountsHost()
	const wanted = useMountsStore(state => {
		const overview = state.overview

		return overview !== null && (overview.drive.enabled || overview.serves.some(serve => serve.enabled))
	})
	const banner = host === null || !wanted ? null : hostBanner(host)

	if (banner === null) {
		return null
	}

	return (
		<DesktopCallout
			tone={banner.tone}
			className="mx-1 mb-2 app-region-no-drag"
			action={
				banner.retry ? (
					<Button
						variant="outline"
						size="xs"
						onClick={() => {
							mountsApi().retryHost()
						}}
					>
						{t("hostRetry")}
					</Button>
				) : undefined
			}
		>
			{t(banner.key)}
		</DesktopCallout>
	)
}

// A role's state beside its row; nothing while it is off.
function RoleState({ role }: { role: MountsRole }) {
	const { t } = useTranslation("mounts")
	const state = useMountsRoleState(role)

	if (state === null || state === "off") {
		return null
	}

	return (
		<span
			className={cn(
				"ml-auto shrink-0 text-xs",
				state === "error"
					? "text-destructive"
					: state === "running"
						? "text-emerald-600 dark:text-emerald-500"
						: "text-muted-foreground"
			)}
		>
			{t(roleStateKey(role, state))}
		</span>
	)
}

// The Mounts section's contextual sidebar: the host's state, the network drive, then one row per protocol server this
// platform offers, each with its state.
export function MountsSidebar() {
	const { t } = useTranslation(["mounts", "common"])

	return (
		<ResizableSidebarPanel
			module="mounts"
			resizeLabel={t("mountsSidebarResize")}
		>
			<nav className="flex flex-1 flex-col overflow-y-auto p-3">
				<h2 className="truncate px-2.5 pt-1 pb-2.5 text-[15px] font-semibold">{t("common:moduleMounts")}</h2>
				<HostBanner />
				<Link
					to="/mounts/$role"
					params={{ role: "drive" }}
					className={SIDEBAR_NAV_ITEM_CLASS}
				>
					<HardDriveIcon className="text-muted-foreground group-data-[status=active]:text-primary" />
					<span className="truncate">{t("mountsNetworkDrive")}</span>
					<RoleState role="drive" />
				</Link>
				<h3 className={GROUP_HEADER_CLASS}>{t("mountsServersHeading")}</h3>
				<div className="flex flex-col gap-0.5">
					{PROTOCOLS.map(protocol => (
						<Link
							key={protocol}
							to="/mounts/$role"
							params={{ role: protocol }}
							className={SIDEBAR_NAV_ITEM_CLASS}
						>
							<ServerIcon className="text-muted-foreground group-data-[status=active]:text-primary" />
							<span className="truncate">{t(PROTOCOL_LABEL_KEY[protocol])}</span>
							<RoleState role={protocol} />
						</Link>
					))}
				</div>
			</nav>
		</ResizableSidebarPanel>
	)
}
