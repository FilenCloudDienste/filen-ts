import { lazy, Suspense, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { SettingsRow } from "@/features/settings/components/settingsLayout"

// The generated notices payload is ~800 KB, so it may only ever be reached through this lazy boundary:
// this row must never import @/features/settings/lib/thirdPartyNotices for any reason (not even a
// package count), or the whole payload lands in the entry chunk.
const ThirdPartyNoticesDialog = lazy(() => import("@/features/settings/components/advanced/thirdPartyNoticesDialog"))

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
				<Suspense fallback={null}>
					<ThirdPartyNoticesDialog
						open
						onOpenChange={setOpen}
					/>
				</Suspense>
			) : null}
		</SettingsRow>
	)
}

export { ThirdPartyNoticesRow }
