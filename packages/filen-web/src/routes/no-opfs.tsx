import { createFileRoute } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { DatabaseXIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

// Terminal page for a browser that could not open the persistent OPFS storage the app requires (SAH
// pool install/open failed — disabled, private browsing, or an unsupported browser). Deliberately
// depends on NOTHING beyond i18n/UI primitives — mirrors /no-coi: the root gate routes here on an
// `opfs` boot failure and always lets it render, so it can never loop back through a gate that will
// never reach "ready".
export const Route = createFileRoute("/no-opfs")({ component: NoOpfsPage })

function NoOpfsPage() {
	const { t } = useTranslation()

	return (
		<div className="flex min-h-svh items-center justify-center bg-background p-6 text-foreground">
			<Empty className="max-w-md">
				<EmptyHeader>
					<EmptyMedia
						variant="icon"
						className="bg-destructive/10 text-destructive"
					>
						<DatabaseXIcon />
					</EmptyMedia>
					<EmptyTitle>{t("noOpfsTitle")}</EmptyTitle>
					<EmptyDescription>{t("noOpfsBody")}</EmptyDescription>
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
