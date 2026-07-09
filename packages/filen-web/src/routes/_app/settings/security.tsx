import { createFileRoute } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { ShieldIcon } from "lucide-react"
import { useAccountQuery } from "@/queries/account"
import { ChangePasswordCard } from "@/features/settings/components/security/changePassword"
import { TwoFactorCard } from "@/features/settings/components/security/twoFactor"
import { ExportMasterKeysCard } from "@/features/settings/components/security/exportMasterKeys"
import { DeleteAccountCard } from "@/features/settings/components/security/deleteAccount"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

// Guard inherited from `_app` (a session already exists by the time this route renders). Every
// card independently reads useAccountQuery (react-query dedupes the shared ["account"] key — one
// request, any number of subscribers), but the page gates on ONE top-level pending/error branch
// (mirrors filen-mobile's security.tsx) so every card mounts only once the account has genuinely
// loaded, rather than each re-deriving the same tri-state branch.
export const Route = createFileRoute("/_app/settings/security")({ component: SecurityPage })

function SecurityPage() {
	const { t } = useTranslation(["auth", "common"])
	const accountQuery = useAccountQuery()

	return (
		<>
			<header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
				<div className="flex items-center gap-2">
					<ShieldIcon className="size-4 text-muted-foreground" />
					<h1 className="font-heading text-base font-medium tracking-tight">{t("securityTitle")}</h1>
				</div>
			</header>
			<div className="flex flex-1 flex-col overflow-y-auto p-6">
				{accountQuery.status === "pending" ? (
					<div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
						<Skeleton className="h-40 w-full rounded-3xl" />
						<Skeleton className="h-40 w-full rounded-3xl" />
						<Skeleton className="h-40 w-full rounded-3xl" />
					</div>
				) : accountQuery.status === "error" ? (
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<ShieldIcon />
							</EmptyMedia>
							<EmptyTitle>{t("securityLoadError")}</EmptyTitle>
						</EmptyHeader>
						<EmptyContent>
							<Button
								variant="outline"
								onClick={() => {
									void accountQuery.refetch()
								}}
							>
								{t("common:tryAgain")}
							</Button>
						</EmptyContent>
					</Empty>
				) : (
					<div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
						<ChangePasswordCard accountQuery={accountQuery} />
						<TwoFactorCard accountQuery={accountQuery} />
						<ExportMasterKeysCard accountQuery={accountQuery} />
						<DeleteAccountCard accountQuery={accountQuery} />
					</div>
				)}
			</div>
		</>
	)
}
