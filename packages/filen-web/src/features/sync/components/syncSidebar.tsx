import { useTranslation } from "react-i18next"
import { SidebarPanel } from "@/features/shell/components/sidebarPanel"

// The Sync section's contextual sidebar; the pair list lands here.
export function SyncSidebar() {
	const { t } = useTranslation("common")

	return (
		<SidebarPanel>
			<div className="flex flex-1 flex-col overflow-y-auto p-3">
				<h2 className="truncate px-2.5 pt-1 pb-2.5 text-[15px] font-semibold">{t("moduleSync")}</h2>
			</div>
		</SidebarPanel>
	)
}
