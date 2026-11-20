import { useEffect, useState } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { redirectIfAuthed } from "@/features/auth/lib/guard"
import { resetTokenFromHash } from "@/features/auth/lib/resetToken.logic"
import { ResetForm } from "@/features/auth/components/resetForm"
import { AuthCard } from "@/features/auth/components/authCard"
import { Button } from "@/components/ui/button"
import { routeHead } from "@/lib/head/routeHead"
import { i18n } from "@/lib/i18n"

// Unauthed page: a live session bounces straight to /drive. Same shared guard as /login and
// /register — see guard.ts. The reset link carries only a token, no email — the form itself asks for
// it (see resetForm.tsx). The token is in the fragment (`/reset#<token>`, resetToken.logic.ts), never the path.
export const Route = createFileRoute("/reset")({
	head: routeHead({ title: () => [i18n.t("auth:resetDocumentTitle")] }),
	beforeLoad: redirectIfAuthed,
	component: ResetPage
})

function ResetPage() {
	const { t } = useTranslation("auth")
	const navigate = useNavigate()
	// Read once: the address bar and this history entry lose the token below, the page keeps it for this visit.
	const [token] = useState(() => resetTokenFromHash(window.location.hash))

	useEffect(() => {
		if (window.location.hash.length > 0) {
			void navigate({ to: "/reset", replace: true })
		}
	}, [navigate])

	return (
		<AuthCard
			title={t("resetTitle")}
			subtitle={t("resetBody")}
		>
			{token === null ? (
				<div className="flex flex-col gap-4 text-center">
					<p className="text-sm font-medium">{t("resetLinkInvalidTitle")}</p>
					<p className="text-sm text-muted-foreground">{t("resetLinkInvalidBody")}</p>
					<Button
						type="button"
						className="w-full"
						onClick={() => {
							void navigate({ to: "/login" })
						}}
					>
						{t("resetGoToSignIn")}
					</Button>
				</div>
			) : (
				<ResetForm token={token} />
			)}
		</AuthCard>
	)
}
