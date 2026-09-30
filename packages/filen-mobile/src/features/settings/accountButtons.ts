import { type Button } from "@/components/ui/settingsGroup"
import { type TFunction } from "i18next"
import { useResolveClassNames } from "uniwind"
import useAccountQuery, { accountQueryPatch } from "@/queries/useAccount.query"
import { formatBytes } from "@filen/shared"
import { confirmPrompt, inputPrompt } from "@/lib/promptFlow"
import alerts from "@/lib/alerts"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import auth from "@/lib/auth"
import { markDirectorySizesStale } from "@/features/drive/queries/useDirectorySize.query"
import { driveItemsQueryInvalidateAfterDeleteAll } from "@/features/drive/queries/useDriveItems.query"
import { clearClipboardAfterDeleteAll } from "@/features/drive/clipboardFollow"
import { router } from "@/lib/router"
import { serialize } from "@/lib/serializer"
import { shareTmpFile } from "@/lib/share"
import { writeTmpFile } from "@/lib/tmp"
import { convertBigInts } from "@/lib/utils"
import { openTrustedUrl } from "@/lib/openTrustedUrl"
import logger from "@/lib/logger"
import { WEB_APP_URL } from "@/constants"

const ACCOUNT_SETTINGS_URL = `${WEB_APP_URL}settings/account`

type AccountQuerySuccess = Extract<ReturnType<typeof useAccountQuery>, { status: "success" }>

// Builds the Account screen "danger zone" settings buttons (delete versioned files /
// delete all files & directories / request account deletion). Extracted verbatim from the
// account screen; each onPress is a confirmed destructive flow. accountQuery is the
// success-narrowed query (the screen only renders these once data has loaded).
export function buildDangerZoneButtons({
	t,
	accountQuery,
	textRed500
}: {
	t: TFunction
	accountQuery: AccountQuerySuccess
	textRed500: ReturnType<typeof useResolveClassNames>
}): Button[] {
	return [
		{
			icon: "trash-bin-outline",
			iconColor: textRed500.color as string,
			title: t("delete_versioned_files"),
			titleClassName: "text-red-500",
			subTitle: formatBytes(Number(accountQuery.data.versionedStorage)),
			requiresOnline: true,
			onPress: async () => {
				if (accountQuery.data.versionedStorage <= 0) {
					return
				}

				const confirmed = await confirmPrompt(
					{
						title: t("delete_versioned_files"),
						message: t("delete_versioned_files_description_non_reversible"),
						okText: t("delete"),
						cancelText: t("cancel"),
						destructive: true
					},
					{ tag: "settings", message: "delete versioned files confirmation prompt failed" }
				)

				if (!confirmed) {
					return
				}

				const reconfirmed = await confirmPrompt(
					{
						title: t("are_you_sure"),
						message: t("delete_versioned_files_description_are_you_sure"),
						okText: t("delete"),
						cancelText: t("cancel"),
						destructive: true
					},
					{ tag: "settings", message: "delete versioned files 2nd confirmation prompt failed" }
				)

				if (!reconfirmed) {
					return
				}

				const result = await runWithLoading(async () => {
					const { authedSdkClient } = await auth.getSdkClients()

					await authedSdkClient.deleteAllVersions()
					markDirectorySizesStale()
					await accountQuery.refetch()
				})

				if (!result.success) {
					logger.error("settings", "deleteAllVersions failed", { error: result.error })
					alerts.error(result.error)

					return
				}
			}
		},
		{
			icon: "trash-outline",
			iconColor: textRed500.color as string,
			title: t("delete_all_files_and_directories"),
			titleClassName: "text-red-500",
			subTitle: formatBytes(Number(accountQuery.data.storageUsed)),
			requiresOnline: true,
			onPress: async () => {
				if (accountQuery.data.storageUsed <= 0) {
					return
				}

				const confirmed = await confirmPrompt(
					{
						title: t("delete_all_files_and_directories"),
						message: t("delete_all_files_and_directories_description_non_reversible"),
						okText: t("delete"),
						cancelText: t("cancel"),
						destructive: true
					},
					{ tag: "settings", message: "delete all files confirmation prompt failed" }
				)

				if (!confirmed) {
					return
				}

				const reconfirmed = await confirmPrompt(
					{
						title: t("are_you_sure"),
						message: t("delete_all_files_and_directories_description_are_you_sure"),
						okText: t("delete"),
						cancelText: t("cancel"),
						destructive: true
					},
					{ tag: "settings", message: "delete all files 2nd confirmation prompt failed" }
				)

				if (!reconfirmed) {
					return
				}

				const result = await runWithLoading(async () => {
					const { authedSdkClient } = await auth.getSdkClients()

					await authedSdkClient.deleteAllItems()
					markDirectorySizesStale()
					// The socket echo does the same, but not while the socket is down.
					driveItemsQueryInvalidateAfterDeleteAll()
					clearClipboardAfterDeleteAll()
					await accountQuery.refetch()
				})

				if (!result.success) {
					logger.error("settings", "deleteAllItems failed", { error: result.error })
					alerts.error(result.error)

					return
				}
			}
		},
		{
			icon: "person-remove-outline",
			iconColor: textRed500.color as string,
			title: t("request_account_deletion"),
			titleClassName: "text-red-500",
			subTitle: t("request_account_deletion_description"),
			requiresOnline: true,
			onPress: async () => {
				const confirmed = await confirmPrompt(
					{
						title: t("request_account_deletion"),
						message: t("request_account_deletion_description_non_reversible_will_send_email_first_to_confirm"),
						okText: t("request"),
						cancelText: t("cancel"),
						destructive: true
					},
					{ tag: "settings", message: "request account deletion prompt failed" }
				)

				if (!confirmed) {
					return
				}

				const reconfirmed = await confirmPrompt(
					{
						title: t("are_you_sure"),
						message: t("request_account_deletion_description_non_reversible_will_send_email_first_to_confirm_are_you_sure"),
						okText: t("request"),
						cancelText: t("cancel"),
						destructive: true
					},
					{ tag: "settings", message: "request account deletion 2nd confirmation prompt failed" }
				)

				if (!reconfirmed) {
					return
				}

				let twoFactorCode: string | undefined = undefined

				if (accountQuery.data.twoFactorEnabled) {
					const twoFactor = await inputPrompt(
						{
							title: t("enter_two_factor_code"),
							message: t("enter_two_factor_code_description_confirm"),
							cancelText: t("cancel"),
							okText: t("request"),
							inputType: "secure-text",
							destructive: true
						},
						{ tag: "settings", message: "delete account 2FA prompt failed" }
					)

					if (twoFactor === null) {
						return
					}

					twoFactorCode = twoFactor
				}

				const result = await runWithLoading(async () => {
					const { authedSdkClient } = await auth.getSdkClients()

					// Only sends a confirmation email; no account field changes yet.
					await authedSdkClient.deleteAccount(twoFactorCode)
				})

				if (!result.success) {
					logger.error("settings", "deleteAccount failed", { error: result.error })
					alerts.error(result.error)

					return
				}

				alerts.normal(t("account_deletion_requested_follow_instructions_sent_to_email"))
			}
		}
	]
}

// Profile settings buttons (change email / nickname / personal info / GDPR export /
// more settings). Extracted verbatim from the account screen.
export function buildProfileButtons({
	t,
	accountQuery
}: {
	t: TFunction
	accountQuery: AccountQuerySuccess
}): Button[] {
	return [
		{
			icon: "mail-outline",
			title: t("change_email_address"),
			subTitle: accountQuery.data.email,
			subTitleNumberOfLines: 1,
			requiresOnline: true,
			onPress: async () => {
				const newEmail = await inputPrompt(
					{
						title: t("change_email_address"),
						message: t("enter_new_email_address"),
						cancelText: t("cancel"),
						okText: t("next"),
						keyboardType: "email-address"
					},
					{ tag: "settings", message: "change email new-email prompt failed" },
					{ trim: true }
				)

				if (newEmail === null) {
					return
				}

				const confirmNewEmail = await inputPrompt(
					{
						title: t("change_email_address"),
						message: t("confirm_new_email_address"),
						cancelText: t("cancel"),
						okText: t("next"),
						keyboardType: "email-address"
					},
					{ tag: "settings", message: "change email confirm-email prompt failed" },
					{ trim: true }
				)

				if (confirmNewEmail === null) {
					return
				}

				if (newEmail !== confirmNewEmail) {
					alerts.error(t("email_addresses_do_not_match"))

					return
				}

				const password = await inputPrompt(
					{
						title: t("change_email_address"),
						message: t("enter_password"),
						cancelText: t("cancel"),
						okText: t("save"),
						inputType: "secure-text"
					},
					{ tag: "settings", message: "change email password prompt failed" }
				)

				if (password === null) {
					return
				}

				const result = await runWithLoading(async () => {
					const { authedSdkClient } = await auth.getSdkClients()

					await authedSdkClient.changeEmail(password, newEmail)
					await accountQuery.refetch()
				})

				if (!result.success) {
					logger.error("settings", "changeEmail failed", { error: result.error })
					alerts.error(result.error)

					return
				}
			}
		},
		{
			icon: "person-outline",
			title: t("change_nickname"),
			subTitle: accountQuery.data.nickName,
			subTitleNumberOfLines: 1,
			requiresOnline: true,
			onPress: async () => {
				const newNickname = await inputPrompt(
					{
						title: t("change_nickname"),
						message: t("enter_nickname"),
						cancelText: t("cancel"),
						okText: t("save"),
						placeholder: accountQuery.data.nickName
					},
					{ tag: "settings", message: "change nickname prompt failed" },
					{ trim: true }
				)

				if (newNickname === null) {
					return
				}

				const result = await runWithLoading(async () => {
					const { authedSdkClient } = await auth.getSdkClients()

					await authedSdkClient.setNickname(newNickname)

					accountQueryPatch({
						nickName: newNickname
					})
				})

				if (!result.success) {
					logger.error("settings", "setNickname failed", { error: result.error })
					alerts.error(result.error)

					return
				}
			}
		},
		{
			icon: "id-card-outline",
			title: t("personal_information"),
			subTitle: t("personal_information_description"),
			onPress: () => {
				router.push({
					pathname: "/account/personal",
					params: {
						personal: serialize(accountQuery.data.personal)
					}
				})
			}
		},
		{
			icon: "document-text-outline",
			title: t("gdpr_information"),
			subTitle: t("gdpr_information_description"),
			requiresOnline: true,
			onPress: async () => {
				const result = await runWithLoading(async () => {
					const { authedSdkClient } = await auth.getSdkClients()

					return writeTmpFile(
						`gdpr_${accountQuery.data.email}.txt`,
						JSON.stringify(convertBigInts(await authedSdkClient.getGdprInfo()), null, 4)
					)
				})

				if (!result.success) {
					logger.error("settings", "getGdprInfo failed", { error: result.error })
					alerts.error(result.error)

					return
				}

				const shareResult = await shareTmpFile({
					uri: result.data.file.uri,
					name: result.data.file.name,
					cleanup: result.data.cleanup
				})

				if (!shareResult.success) {
					logger.warn("settings", "GDPR file share failed", { error: shareResult.error })
					alerts.error(shareResult.error)

					return
				}
			}
		},
		{
			icon: "settings-outline",
			title: t("more_account_settings"),
			onPress: async () => {
				const confirmed = await confirmPrompt(
					{
						title: t("open_web_app"),
						message: t("open_web_app_to_change_more_settings_do_you_want_to_open_it"),
						okText: t("open"),
						cancelText: t("cancel")
					},
					{ tag: "settings", message: "open web app prompt failed" }
				)

				if (!confirmed) {
					return
				}

				await openTrustedUrl("settings", ACCOUNT_SETTINGS_URL)
			}
		}
	]
}

function buildAccountToggleButton({
	accountQuery,
	field,
	sdkSetter,
	icon,
	title,
	subTitle
}: {
	accountQuery: AccountQuerySuccess
	field: "versioningEnabled" | "loginAlertsEnabled"
	sdkSetter: "setVersioningEnabled" | "setLoginAlertsEnabled"
	icon: Button["icon"]
	title: string
	subTitle: string
}): Button {
	return {
		icon,
		title,
		subTitle,
		requiresOnline: true,
		rightItem: {
			type: "switch",
			value: accountQuery.data[field],
			onValueChange: async () => {
				const result = await runWithLoading(async () => {
					const { authedSdkClient } = await auth.getSdkClients()

					const enabled = !accountQuery.data[field]

					await authedSdkClient[sdkSetter](enabled)

					accountQueryPatch({
						[field]: enabled
					})
				})

				if (!result.success) {
					logger.error("settings", `${sdkSetter} failed`, { error: result.error })
					alerts.error(result.error)

					return
				}
			}
		}
	}
}

// Account feature toggles (file versioning / login alerts).
export function buildAccountToggleButtons({
	t,
	accountQuery
}: {
	t: TFunction
	accountQuery: AccountQuerySuccess
}): Button[] {
	return [
		buildAccountToggleButton({
			accountQuery,
			field: "versioningEnabled",
			sdkSetter: "setVersioningEnabled",
			icon: "layers-outline",
			title: t("file_versioning"),
			subTitle: t("file_versioning_description")
		}),
		buildAccountToggleButton({
			accountQuery,
			field: "loginAlertsEnabled",
			sdkSetter: "setLoginAlertsEnabled",
			icon: "notifications-outline",
			title: t("login_alerts"),
			subTitle: t("login_alerts_description")
		})
	]
}

// 2FA enable / disable switch button. Extracted verbatim from twoFactor.tsx.
export function buildTwoFactorButtons({
	t,
	accountQuery
}: {
	t: TFunction
	accountQuery: AccountQuerySuccess
}): Button[] {
	return [
		{
			icon: "shield-checkmark-outline",
			title: t("two_factor_authentication"),
			subTitle: t("two_factor_authentication_description"),
			requiresOnline: true,
			rightItem: {
				type: "switch",
				value: accountQuery.data.twoFactorEnabled,
				onValueChange: async () => {
					if (accountQuery.data.twoFactorEnabled) {
						const confirmed = await confirmPrompt(
							{
								title: t("disable_two_factor_authentication"),
								message: t("disable_two_factor_authentication_description"),
								okText: t("continue"),
								cancelText: t("cancel"),
								destructive: true
							},
							{ tag: "settings", message: "disable 2FA confirmation prompt failed" }
						)

						if (!confirmed) {
							return
						}

						const twoFactor = await inputPrompt(
							{
								title: t("enter_two_factor_code"),
								message: t("enter_two_factor_code_description"),
								cancelText: t("cancel"),
								okText: t("disable"),
								inputType: "secure-text",
								destructive: true
							},
							{ tag: "settings", message: "disable 2FA code prompt failed" }
						)

						if (twoFactor === null) {
							return
						}

						const result = await runWithLoading(async () => {
							await (await auth.getSdkClients()).authedSdkClient.disable2fa(twoFactor)
							// A reread, not a patch: the setup key the screen shows next is only returned
							// once 2FA is off, and whether the server issues a new one isn't known here.
							await accountQuery.refetch()
						})

						if (!result.success) {
							logger.error("settings", "disable2fa failed", { error: result.error })
							alerts.error(result.error)

							return
						}

						return
					}

					const twoFactor = await inputPrompt(
						{
							title: t("enter_two_factor_code"),
							message: t("enter_two_factor_code_description"),
							cancelText: t("cancel"),
							okText: t("enable"),
							inputType: "secure-text"
						},
						{ tag: "settings", message: "enable 2FA code prompt failed" }
					)

					if (twoFactor === null) {
						return
					}

					const result = await runWithLoading(async () => {
						const recoverKey = await (await auth.getSdkClients()).authedSdkClient.enable2faGetRecoveryKey(twoFactor)

						// getUserInfo withholds the key while 2FA is on; mirror that.
						accountQueryPatch({
							twoFactorEnabled: true,
							twoFactorKey: undefined
						})

						return recoverKey
					})

					if (!result.success) {
						logger.error("settings", "enable2faGetRecoveryKey failed", { error: result.error })
						alerts.error(result.error)

						return
					}

					const recoverKey = result.data

					router.push({
						pathname: "/security/recoveryKey",
						params: { recoveryKey: recoverKey }
					})
				}
			}
		}
	]
}

// Logout button (confirm prompt -> auth.logout()).
export function buildLogoutButtons({ t }: { t: TFunction }): Button[] {
	return [
		{
			icon: "log-out-outline",
			title: t("logout"),
			onPress: async () => {
				const confirmed = await confirmPrompt(
					{
						title: t("logout"),
						message: t("logout_confirm_wipes_local_data"),
						okText: t("logout"),
						cancelText: t("cancel"),
						destructive: true
					},
					{ tag: "settings", message: "logout confirmation prompt failed" }
				)

				if (!confirmed) {
					return
				}

				const result = await runWithLoading(async () => {
					await auth.logout()
				})

				if (!result.success) {
					logger.error("settings", "logout failed", { error: result.error })
					alerts.error(result.error)

					return
				}
			}
		}
	]
}
