import { Link } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { FileQuestionIcon } from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
import { FullScreenNotice } from "@/components/fullScreenNotice"

// The router's global not-found page. One action, no auth branch: "/"'s own guard forwards an authed
// visitor to their start screen and an unauthed one to sign-in.
export function NotFoundScreen() {
	const { t } = useTranslation()

	return (
		<FullScreenNotice
			icon={<FileQuestionIcon />}
			title={t("notFoundTitle")}
			description={t("notFoundBody")}
		>
			<Link
				to="/"
				className={buttonVariants()}
			>
				{t("notFoundAction")}
			</Link>
		</FullScreenNotice>
	)
}
