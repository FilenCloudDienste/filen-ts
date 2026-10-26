import { useTranslation } from "react-i18next"
import { Link } from "@tanstack/react-router"
import { HardDriveIcon, ServerIcon } from "lucide-react"
import { ResizableSidebarPanel } from "@/features/shell/components/sidebarPanel"
import { GROUP_HEADER_CLASS, SIDEBAR_NAV_ITEM_CLASS } from "@/features/shell/lib/sidebarNavItem"
import { offeredProtocols, PROTOCOL_LABEL_KEY } from "@/features/mounts/lib/mountsRoles"
import { desktopPlatform } from "@/lib/desktop"

// The platform never changes mid-session.
const PROTOCOLS = offeredProtocols(desktopPlatform())

// The Mounts section's contextual sidebar: the network drive, then one row per protocol server this platform offers.
export function MountsSidebar() {
	const { t } = useTranslation(["mounts", "common"])

	return (
		<ResizableSidebarPanel
			module="mounts"
			resizeLabel={t("mountsSidebarResize")}
		>
			<nav className="flex flex-1 flex-col overflow-y-auto p-3">
				<h2 className="truncate px-2.5 pt-1 pb-2.5 text-[15px] font-semibold">{t("common:moduleMounts")}</h2>
				<Link
					to="/mounts/$role"
					params={{ role: "drive" }}
					className={SIDEBAR_NAV_ITEM_CLASS}
				>
					<HardDriveIcon className="text-muted-foreground group-data-[status=active]:text-primary" />
					<span className="truncate">{t("mountsNetworkDrive")}</span>
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
						</Link>
					))}
				</div>
			</nav>
		</ResizableSidebarPanel>
	)
}
