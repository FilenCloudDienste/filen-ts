import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { DEFAULT_RAIL_ORDER } from "@/features/shell/lib/railOrder.logic"
import { saveRailOrder } from "@/features/shell/queries/railOrder"
import { ResetRow } from "@/features/settings/components/settingRows"

// The icon rail's order is changed by dragging on the rail itself; this row only puts it back.
function RailOrderRow() {
	const { t } = useTranslation("settings")

	return (
		<ResetRow
			title={t("settingsRailReset")}
			description={t("settingsRailResetDescription")}
			onReset={() => {
				saveRailOrder([...DEFAULT_RAIL_ORDER])
				toast.success(t("settingsRailResetSuccess"))
			}}
		/>
	)
}

export { RailOrderRow }
