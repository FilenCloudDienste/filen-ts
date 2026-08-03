import { Link } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { FileQuestionIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

// The router's global not-found page, same full-screen centred geometry as the boot-error and
// capability screens. One action, no auth branch: "/"'s own guard forwards an authed visitor to their
// start screen and an unauthed one to sign-in.
export function NotFoundScreen() {
	const { t } = useTranslation()

	return (
		<div className="flex min-h-svh items-center justify-center bg-canvas p-6 text-foreground">
			<Empty className="max-w-md">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<FileQuestionIcon />
					</EmptyMedia>
					<EmptyTitle>{t("notFoundTitle")}</EmptyTitle>
					<EmptyDescription>{t("notFoundBody")}</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button render={<Link to="/" />}>{t("notFoundAction")}</Button>
				</EmptyContent>
			</Empty>
		</div>
	)
}
