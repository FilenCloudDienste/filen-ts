import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { DEFAULT_RAIL_ORDER } from "@/features/shell/lib/railOrder.logic"
import { saveRailOrder } from "@/features/shell/queries/railOrder"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { ResetRow } from "@/features/settings/components/settingRows"

// The icon rail's order is changed by dragging on the rail itself; this card only puts it back.
function RailOrderCard() {
	const { t } = useTranslation("settings")

	return (
		<Card>
			<CardHeader>
				<CardTitle>{t("settingsRailTitle")}</CardTitle>
				<CardDescription>{t("settingsRailDescription")}</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col">
				<ResetRow
					title={t("settingsRailReset")}
					description={t("settingsRailResetDescription")}
					onReset={() => {
						saveRailOrder([...DEFAULT_RAIL_ORDER])
						toast.success(t("settingsRailResetSuccess"))
					}}
				/>
			</CardContent>
		</Card>
	)
}

export { RailOrderCard }
