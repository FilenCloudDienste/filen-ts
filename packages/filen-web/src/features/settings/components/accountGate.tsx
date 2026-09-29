import type { ComponentProps, ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { useAccountQuery, type AccountQuerySuccess } from "@/queries/account"
import { SettingsPage } from "@/features/settings/components/settingsLayout"
import { Button } from "@/components/ui/button"
import { LoadingState } from "@/components/loadingState"
import { EmptyMessage } from "@/components/emptyMessage"

// A settings page whose rows all read the account. Each row still reads useAccountQuery (the shared
// ["account"] key dedupes it), but the page gates on ONE branch so every row mounts only once the
// account has genuinely loaded. The gate is on the data, not the status: a failed background read
// keeps the cached account, and unmounting over it would drop what the user was looking at (the 2FA
// row's one-time recovery key among it).
export function AccountGate({
	icon: Icon,
	title,
	children
}: {
	icon: ComponentProps<typeof SettingsPage>["icon"]
	title: string
	children: (accountQuery: AccountQuerySuccess) => ReactNode
}) {
	const { t } = useTranslation(["settings", "common"])
	const accountQuery = useAccountQuery()

	return (
		<SettingsPage
			icon={Icon}
			title={title}
		>
			{accountQuery.data !== undefined ? (
				children(accountQuery)
			) : accountQuery.status === "error" ? (
				<EmptyMessage
					icon={Icon}
					title={t("settingsAccountLoadError")}
				>
					<Button
						variant="outline"
						onClick={() => {
							void accountQuery.refetch()
						}}
					>
						{t("common:tryAgain")}
					</Button>
				</EmptyMessage>
			) : (
				<LoadingState size="lg" />
			)}
		</SettingsPage>
	)
}
