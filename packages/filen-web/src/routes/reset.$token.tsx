import { createFileRoute } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { redirectIfAuthed } from "@/features/auth/lib/guard"
import { ResetForm } from "@/features/auth/components/resetForm"
import { AuthCard } from "@/features/auth/components/authCard"
import { routeHead } from "@/lib/head/routeHead"
import { i18n } from "@/lib/i18n"

// Unauthed page: a live session bounces straight to /drive. Same shared guard as /login and
// /register — see guard.ts. The reset link carries only a token, no email — the form itself asks for
// it (see resetForm.tsx).
export const Route = createFileRoute("/reset/$token")({
	head: routeHead({ title: () => [i18n.t("auth:resetDocumentTitle")] }),
	beforeLoad: redirectIfAuthed,
	component: ResetPage
})

function ResetPage() {
	const { t } = useTranslation("auth")
	const { token } = Route.useParams()

	return (
		<AuthCard
			title={t("resetTitle")}
			subtitle={t("resetBody")}
		>
			<ResetForm token={token} />
		</AuthCard>
	)
}
