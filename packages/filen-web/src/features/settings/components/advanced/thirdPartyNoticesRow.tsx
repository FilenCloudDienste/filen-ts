import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { SettingsRow } from "@/features/settings/components/settingsLayout"
import { ThirdPartyNoticesDialog } from "@/features/settings/components/advanced/thirdPartyNoticesDialog"

function ThirdPartyNoticesRow() {
	const { t } = useTranslation("settings")
	const [open, setOpen] = useState(false)

	return (
		<SettingsRow
			label={t("settingsNoticesTitle")}
			description={t("settingsNoticesDescription")}
		>
			{/* No offline gate: the data is compiled into the bundle, nothing is fetched. */}
			<Button
				type="button"
				variant="outline"
				onClick={() => {
					setOpen(true)
				}}
			>
				{t("settingsNoticesOpen")}
			</Button>
			{open ? (
				<ThirdPartyNoticesDialog
					open
					onOpenChange={setOpen}
				/>
			) : null}
		</SettingsRow>
	)
}

export { ThirdPartyNoticesRow }
