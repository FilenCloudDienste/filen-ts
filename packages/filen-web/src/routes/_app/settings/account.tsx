import { createFileRoute } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { UserIcon } from "lucide-react"
import { useAccountQuery } from "@/queries/account"
import { AvatarCard } from "@/features/settings/components/account/avatarCard"
import { ChangeEmailCard } from "@/features/settings/components/account/changeEmail"
import { NicknameCard } from "@/features/settings/components/account/nicknameCard"
import { PersonalInfoCard } from "@/features/settings/components/account/personalInfoCard"
import { StorageBreakdownCard } from "@/features/settings/components/account/storageBreakdownCard"
import { GdprExportCard } from "@/features/settings/components/account/gdprExportCard"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

// Same one-top-level-gate shape as the Security page: every card independently reads
// useAccountQuery (dedupe via the shared ["account"] key), but the page gates on ONE
// pending/error branch so every card mounts only once the account has genuinely loaded.
export const Route = createFileRoute("/_app/settings/account")({ component: AccountPage })

function AccountPage() {
	const { t } = useTranslation(["settings", "common"])
	const accountQuery = useAccountQuery()

	return (
		<>
			<header className="flex h-14 shrink-0 items-center gap-3 px-4">
				<div className="flex items-center gap-2">
					<UserIcon className="size-4 text-muted-foreground" />
					<h1 className="font-heading text-base font-medium tracking-tight">{t("settingsSectionAccount")}</h1>
				</div>
			</header>
			<div className="flex flex-1 flex-col overflow-y-auto p-6">
				{accountQuery.status === "pending" ? (
					<div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
						<Skeleton className="h-24 w-full rounded-3xl" />
						<Skeleton className="h-40 w-full rounded-3xl" />
						<Skeleton className="h-40 w-full rounded-3xl" />
					</div>
				) : accountQuery.status === "error" ? (
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<UserIcon />
							</EmptyMedia>
							<EmptyTitle>{t("settingsAccountLoadError")}</EmptyTitle>
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
						<AvatarCard accountQuery={accountQuery} />
						<ChangeEmailCard accountQuery={accountQuery} />
						<NicknameCard accountQuery={accountQuery} />
						<PersonalInfoCard accountQuery={accountQuery} />
						<StorageBreakdownCard accountQuery={accountQuery} />
						<GdprExportCard />
					</div>
				)}
			</div>
		</>
	)
}
