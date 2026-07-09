import { createFileRoute } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { ShieldAlertIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

// Terminal page for a browser that did not load the app cross-origin-isolated (COOP/COEP missing).
// Deliberately depends on NOTHING from the SDK — the root gate routes here on a `coi` boot failure and
// always lets it render, so it can never loop back through a gate that will never reach "ready".
export const Route = createFileRoute("/no-coi")({ component: NoCoiPage })

function NoCoiPage() {
	const { t } = useTranslation()

	return (
		<div className="flex min-h-svh items-center justify-center bg-canvas p-6 text-foreground">
			<Empty className="max-w-md">
				<EmptyHeader>
					<EmptyMedia
						variant="icon"
						className="bg-destructive/10 text-destructive"
					>
						<ShieldAlertIcon />
					</EmptyMedia>
					<EmptyTitle>{t("noCoiTitle")}</EmptyTitle>
					<EmptyDescription>{t("noCoiBody")}</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button
						onClick={() => {
							window.location.reload()
						}}
					>
						{t("reload")}
					</Button>
				</EmptyContent>
			</Empty>
		</div>
	)
}
