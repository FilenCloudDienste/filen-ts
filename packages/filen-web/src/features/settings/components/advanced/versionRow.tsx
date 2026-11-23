import { useState } from "react"
import { useTranslation } from "react-i18next"
import { CheckIcon, CopyIcon } from "lucide-react"
import { buildId, buildLabel } from "@/lib/buildId"
import { copyText } from "@/lib/copyText"
import { desktopBridge } from "@/lib/desktop"
import { Button } from "@/components/ui/button"
import { SettingsRow } from "@/features/settings/components/settingsLayout"

// Enough of the commit to name it; the copy carries all of it.
const SHORT_BUILD_LENGTH = 12

// The build this page came from, for bug reports. The desktop app names its version under Settings → Desktop → About
// instead, so the row is for the browser only.
function VersionRow() {
	const { t } = useTranslation("settings")
	const [copied, setCopied] = useState(false)

	if (desktopBridge() !== undefined) {
		return null
	}

	const build = buildId()
	const label = buildLabel()

	async function handleCopy(): Promise<void> {
		if (!(await copyText(label, t("settingsVersionCopied")))) {
			return
		}

		setCopied(true)
		setTimeout(() => {
			setCopied(false)
		}, 2000)
	}

	return (
		<SettingsRow label={t("settingsVersionTitle")}>
			<span
				className="font-mono text-sm text-muted-foreground"
				title={label}
			>
				{build === null ? t("settingsVersionLocal") : build.slice(0, SHORT_BUILD_LENGTH)}
			</span>
			<Button
				type="button"
				variant="outline"
				size="icon"
				aria-label={t("settingsVersionCopy")}
				onClick={() => {
					void handleCopy()
				}}
			>
				{copied ? <CheckIcon /> : <CopyIcon />}
			</Button>
		</SettingsRow>
	)
}

export { VersionRow }
