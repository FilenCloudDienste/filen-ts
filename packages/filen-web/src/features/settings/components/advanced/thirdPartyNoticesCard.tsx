import { lazy, Suspense, useState } from "react"
import { useTranslation } from "react-i18next"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"

// The generated notices payload is ~800 KB, so it may only ever be reached through this lazy boundary:
// this card must never import @/features/settings/lib/thirdPartyNotices for any reason (not even a
// package count), or the whole payload lands in the entry chunk.
const ThirdPartyNoticesDialog = lazy(() => import("@/features/settings/components/advanced/thirdPartyNoticesDialog"))

function ThirdPartyNoticesCard() {
	const { t } = useTranslation("settings")
	const [open, setOpen] = useState(false)

	return (
		<Card>
			<CardHeader>
				<CardTitle>{t("settingsNoticesTitle")}</CardTitle>
				<CardDescription>{t("settingsNoticesDescription")}</CardDescription>
			</CardHeader>
			<CardContent>
				{/* No offline gate: the data is compiled into the bundle, nothing is fetched. */}
				<Button
					variant="outline"
					size="sm"
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
			</CardContent>
		</Card>
	)
}

export { ThirdPartyNoticesCard }
