import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { sdkApi } from "@/lib/sdk/client"
import { asErrorDTO } from "@/lib/sdk/errors"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { downloadBlob } from "@/lib/downloadBlob"
import { gdprInfoToJson } from "@/features/settings/lib/gdprExport"
import { Card, CardFooter, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

// Read-only fetch (getUserInfo/getUserEvents/getGdprInfo mutate nothing, so they are safe to
// e2e-invoke live) → client-built JSON blob → the shared download primitive (downloadBlob.ts), same anchor-click
// convention as notes export and the security cards' text exports. No dialog, no confirmation —
// this never mutates account state.
function GdprExportCard() {
	const { t } = useTranslation("settings")
	const [pending, setPending] = useState(false)

	async function handleExport(): Promise<void> {
		setPending(true)
		try {
			const info = await sdkApi.getGdprInfo()
			downloadBlob(`filen-data-export.${String(Date.now())}.json`, new Blob([gdprInfoToJson(info)], { type: "application/json" }))
			toast.success(t("settingsGdprSuccess"))
		} catch (e) {
			toast.error(errorLabel(asErrorDTO(e)))
		} finally {
			setPending(false)
		}
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>{t("settingsGdprTitle")}</CardTitle>
				<CardDescription>{t("settingsGdprDescription")}</CardDescription>
			</CardHeader>
			<CardFooter>
				<Button
					type="button"
					variant="outline"
					disabled={pending}
					onClick={() => {
						void handleExport()
					}}
				>
					{pending && <Spinner data-icon="inline-start" />}
					{t("settingsGdprExportAction")}
				</Button>
			</CardFooter>
		</Card>
	)
}

export { GdprExportCard }
