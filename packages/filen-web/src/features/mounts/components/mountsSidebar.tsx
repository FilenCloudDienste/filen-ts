import { useTranslation } from "react-i18next"
import { Link } from "@tanstack/react-router"
import { LayoutGridIcon } from "lucide-react"
import { useShallow } from "zustand/shallow"
import { cn } from "@filen/shared"
import { Button } from "@/components/ui/button"
import { desktopPlatform } from "@/lib/desktop"
import { ResizableSidebarPanel } from "@/features/shell/components/sidebarPanel"
import { GROUP_HEADER_CLASS, SIDEBAR_NAV_ITEM_CLASS } from "@/features/shell/lib/sidebarNavItem"
import { rememberLastOpened } from "@/features/shell/lib/lastOpened"
import { hostBanner } from "@/features/desktop/lib/hostBanner.logic"
import { DesktopCallout } from "@/features/desktop/components/desktopCallout"
import { offeredProtocols, PROTOCOL_LABEL_KEY, type MountsRole } from "@/features/mounts/lib/mountsRoles"
import { mountsApi, useMountsHost, useMountsStore } from "@/features/mounts/lib/mountsStore"
import { roleStateKey, roleSummary } from "@/features/mounts/lib/mountsStatus.logic"
import { ROLE_ICON } from "@/features/mounts/lib/mountsIcons"
import { MOUNTS_OVERVIEW } from "@/features/mounts/lib/indexRedirect.logic"
import { RoleStatusDot } from "@/features/mounts/components/roleStatus"

// The platform never changes mid-session.
const PROTOCOLS = offeredProtocols(desktopPlatform())
const WINDOWS = desktopPlatform() === "win32"

const ROLE_ROW_CLASS = cn(SIDEBAR_NAV_ITEM_CLASS, "h-auto min-h-8 py-1.5")

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

// One role: its icon, name over where it is reachable, and its state as a dot (spoken with the name). Selects only
// what it draws, so another role's change re-renders nothing here.
function RoleRow({ role, label }: { role: MountsRole; label: string }) {
	const { t } = useTranslation("mounts")
	const summary = useMountsStore(useShallow(state => roleSummary(state.overview, role)))
	const Icon = ROLE_ICON[role]
	// A drive without its own place mounts at the default one; Windows' default letter is only known once mounted.
	const address = summary?.address ?? (role === "drive" && !WINDOWS ? t("driveMountPointDefault") : null)

	return (
		<Link
			to="/mounts/$role"
			params={{ role }}
			className={ROLE_ROW_CLASS}
		>
			<Icon className="text-muted-foreground group-data-[status=active]:text-primary" />
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="truncate">
					{label}
					{summary === null ? null : <span className="sr-only">, {t(roleStateKey(role, summary.state))}</span>}
				</span>
				{address === null ? null : <span className="truncate text-xs font-normal text-muted-foreground">{address}</span>}
			</span>
			{summary === null ? null : <RoleStatusDot state={summary.state} />}
		</Link>
	)
}

// The Mounts section's contextual sidebar: the host's state, the overview, the network drive, then one row per
// protocol server this platform offers. Choosing the overview is remembered like a role, so the rail reopens it.
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
				<div className="flex flex-col gap-0.5">
					<Link
						to="/mounts"
						activeOptions={{ exact: true }}
						className={SIDEBAR_NAV_ITEM_CLASS}
						onClick={() => {
							rememberLastOpened("mounts", MOUNTS_OVERVIEW)
						}}
					>
						<LayoutGridIcon className="text-muted-foreground group-data-[status=active]:text-primary" />
						<span className="truncate">{t("mountsOverview")}</span>
					</Link>
					<RoleRow
						role="drive"
						label={t("mountsNetworkDrive")}
					/>
				</div>
				<h3 className={GROUP_HEADER_CLASS}>{t("mountsServersHeading")}</h3>
				<div className="flex flex-col gap-0.5">
					{PROTOCOLS.map(protocol => (
						<RoleRow
							key={protocol}
							role={protocol}
							label={t(PROTOCOL_LABEL_KEY[protocol])}
						/>
					))}
				</div>
			</nav>
		</ResizableSidebarPanel>
	)
}
