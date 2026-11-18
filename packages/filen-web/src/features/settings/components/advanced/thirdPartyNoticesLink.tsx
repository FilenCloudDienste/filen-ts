import { useState } from "react"
import { useTranslation } from "react-i18next"
import { ThirdPartyNoticesDialog } from "@/features/settings/components/advanced/thirdPartyNoticesDialog"

// The third party notices as a footer link, for screens a visitor without a session reaches (sign-in, public
// links), who runs the same bundled code a signed-in user reaches through settings. The dialog mounts on open.
function ThirdPartyNoticesLink({ className }: { className?: string }) {
	const { t } = useTranslation("settings")
	const [open, setOpen] = useState(false)

	return (
		<>
			<button
				type="button"
				className={className}
				onClick={() => {
					setOpen(true)
				}}
			>
				{t("settingsThirdPartyNoticesTitle")}
			</button>
			{open ? (
				<ThirdPartyNoticesDialog
					open
					onOpenChange={setOpen}
				/>
			) : null}
		</>
	)
}

export { ThirdPartyNoticesLink }
