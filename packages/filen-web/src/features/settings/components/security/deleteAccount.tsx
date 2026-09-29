import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { sdkApi } from "@/lib/sdk/client"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { useIsOnline } from "@/lib/useIsOnline"
import type { AccountQuerySuccess } from "@/queries/account"
import {
	advanceDeleteAccountChain,
	type DeleteAccountConfirmStage,
	type DeleteAccountStage
} from "@/features/settings/components/security/deleteAccount.logic"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { InputDialog } from "@/components/dialogs/inputDialog"
import { SettingsRow } from "@/features/settings/components/settingsLayout"

interface DeleteAccountRowProps {
	accountQuery: AccountQuerySuccess
}

// Two destructive confirms, then — only when the account has two-factor authentication enabled —
// a code prompt (advanceDeleteAccountChain, deleteAccount.logic.ts owns the pure transition).
// deleteAccount() only REQUESTS deletion: the server emails a confirmation link and actual deletion
// completes on filen.io (homepage-owned, mirroring how registration confirmation and reset
// completion are also email-link-driven flows this app does not own a route for). This row never
// performs any further client-side action once the request lands. This screen is verified by unit
// tests + a static render check only — the deletion request is NEVER exercised against a live
// account.
function DeleteAccountRow({ accountQuery }: DeleteAccountRowProps) {
	const { t } = useTranslation(["auth", "common"])
	const isOnline = useIsOnline()
	const { twoFactorEnabled } = accountQuery.data
	const [chainStage, setChainStage] = useState<DeleteAccountStage | null>(null)
	const [pending, setPending] = useState(false)

	function handleStageOutcome(stage: DeleteAccountConfirmStage, confirmed: boolean): void {
		const outcome = advanceDeleteAccountChain(stage, confirmed, twoFactorEnabled)
		switch (outcome.status) {
			case "aborted":
				setChainStage(null)
				break
			case "advance":
				setChainStage(outcome.stage)
				break
			case "submit":
				void runDelete(undefined)
				break
		}
	}

	async function runDelete(code: string | undefined): Promise<void> {
		setPending(true)
		try {
			await sdkApi.deleteAccount(code)
			setChainStage(null)
			toast.success(t("deleteAccountConfirmationSent"))
		} catch (e) {
			toast.error(errorLabel(e))
		} finally {
			setPending(false)
		}
	}

	return (
		<SettingsRow
			label={t("deleteAccountTitle")}
			description={t("deleteAccountDescription")}
			destructive
		>
			<Button
				type="button"
				variant="destructive"
				disabled={!isOnline}
				title={!isOnline ? t("common:offlineActionDisabled") : undefined}
				onClick={() => {
					setChainStage("stage1")
				}}
			>
				{t("deleteAccountSubmit")}
			</Button>

			<ConfirmDialog
				open={chainStage === "stage1"}
				pending={false}
				title={t("deleteAccountTitle")}
				body={t("deleteAccountBody")}
				confirmLabel={t("deleteAccountSubmit")}
				cancelLabel={t("common:cancel")}
				destructive
				onOpenChange={open => {
					if (!open) {
						handleStageOutcome("stage1", false)
					}
				}}
				onConfirm={() => {
					handleStageOutcome("stage1", true)
				}}
			/>
			<ConfirmDialog
				open={chainStage === "stage2"}
				pending={pending}
				title={t("deleteAccountConfirmTitle")}
				body={t("deleteAccountConfirmBody")}
				confirmLabel={t("deleteAccountSubmit")}
				cancelLabel={t("common:cancel")}
				destructive
				onOpenChange={open => {
					if (!open) {
						handleStageOutcome("stage2", false)
					}
				}}
				onConfirm={() => {
					handleStageOutcome("stage2", true)
				}}
			/>
			<InputDialog
				open={chainStage === "code"}
				pending={pending}
				title={t("twoFactorEnterCodeTitle")}
				body={t("deleteAccountTwoFactorPrompt")}
				label={t("twoFactorCode")}
				inputMode="numeric"
				autoComplete="one-time-code"
				maxLength={6}
				submitLabel={t("deleteAccountSubmit")}
				validate={value => value.trim().length > 0}
				onOpenChange={open => {
					if (!open) {
						setChainStage(null)
					}
				}}
				onSubmit={code => {
					void runDelete(code)
				}}
			/>
		</SettingsRow>
	)
}

export { DeleteAccountRow }
