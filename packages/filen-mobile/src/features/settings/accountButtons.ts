import { type Button } from "@/components/ui/settingsGroup"
import { type TFunction } from "i18next"
import { useResolveClassNames } from "uniwind"
import useAccountQuery from "@/queries/useAccount.query"
import { run, formatBytes } from "@filen/utils"
import prompts from "@/lib/prompts"
import alerts from "@/lib/alerts"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import auth from "@/lib/auth"
import { router } from "expo-router"
import { serialize } from "@/lib/serializer"
import { shareTmpFile } from "@/lib/share"
import { newTmpFile } from "@/lib/tmp"
import { convertBigInts } from "@/lib/utils"
import * as Linking from "expo-linking"

type AccountQuerySuccess = Extract<ReturnType<typeof useAccountQuery>, { status: "success" }>

// Builds the Account screen "danger zone" settings buttons (delete versioned files /
// delete all files & directories / request account deletion). Extracted verbatim from the
// account screen; each onPress is a confirmed destructive flow. accountQuery is the
// success-narrowed query (the screen only renders these once data has loaded).
export function buildDangerZoneButtons({
	t,
	accountQuery,
	isOnline,
	textRed500
}: {
	t: TFunction
	accountQuery: AccountQuerySuccess
	isOnline: boolean
	textRed500: ReturnType<typeof useResolveClassNames>
}): Button[] {
	return [
		{
			icon: "time-outline",
			iconColor: textRed500.color as string,
			title: t("delete_versioned_files"),
			titleClassName: "text-red-500",
			subTitle: formatBytes(Number(accountQuery.data.versionedStorage)),
			disabled: !isOnline,
			onPress: async () => {
				if (accountQuery.data.versionedStorage <= 0) {
					return
				}

				const promptResult = await run(async () => {
					return await prompts.alert({
						title: t("delete_versioned_files"),
						message: t("delete_versioned_files_description_non_reversible"),
						okText: t("delete"),
						cancelText: t("cancel"),
						destructive: true
					})
				})

				if (!promptResult.success) {
					console.error(promptResult.error)
					alerts.error(promptResult.error)

					return
				}

				if (promptResult.data.cancelled) {
					return
				}

				const confirmPromptResult = await run(async () => {
					return await prompts.alert({
						title: t("are_you_sure"),
						message: t("delete_versioned_files_description_are_you_sure"),
						okText: t("delete"),
						cancelText: t("cancel"),
						destructive: true
					})
				})

				if (!confirmPromptResult.success) {
					console.error(confirmPromptResult.error)
					alerts.error(confirmPromptResult.error)

					return
				}

				if (confirmPromptResult.data.cancelled) {
					return
				}

				const result = await runWithLoading(async () => {
					const { authedSdkClient } = await auth.getSdkClients()

					await authedSdkClient.deleteAllVersions()
					await accountQuery.refetch()
				})

				if (!result.success) {
					console.error(result.error)
					alerts.error(result.error)

					return
				}
			}
		},
		{
			icon: "time-outline",
			iconColor: textRed500.color as string,
			title: t("delete_all_files_and_directories"),
			titleClassName: "text-red-500",
			subTitle: formatBytes(Number(accountQuery.data.storageUsed)),
			disabled: !isOnline,
			onPress: async () => {
				if (accountQuery.data.storageUsed <= 0) {
					return
				}

				const promptResult = await run(async () => {
					return await prompts.alert({
						title: t("delete_all_files_and_directories"),
						message: t("delete_all_files_and_directories_description_non_reversible"),
						okText: t("delete"),
						cancelText: t("cancel"),
						destructive: true
					})
				})

				if (!promptResult.success) {
					console.error(promptResult.error)
					alerts.error(promptResult.error)

					return
				}

				if (promptResult.data.cancelled) {
					return
				}

				const confirmPromptResult = await run(async () => {
					return await prompts.alert({
						title: t("are_you_sure"),
						message: t("delete_all_files_and_directories_description_are_you_sure"),
						okText: t("delete"),
						cancelText: t("cancel"),
						destructive: true
					})
				})

				if (!confirmPromptResult.success) {
					console.error(confirmPromptResult.error)
					alerts.error(confirmPromptResult.error)

					return
				}

				if (confirmPromptResult.data.cancelled) {
					return
				}

				const result = await runWithLoading(async () => {
					const { authedSdkClient } = await auth.getSdkClients()

					await authedSdkClient.deleteAllItems()
					await accountQuery.refetch()
				})

				if (!result.success) {
					console.error(result.error)
					alerts.error(result.error)

					return
				}
			}
		},
		{
			icon: "time-outline",
			iconColor: textRed500.color as string,
			title: t("request_account_deletion"),
			titleClassName: "text-red-500",
			subTitle: t("request_account_deletion_description"),
			disabled: !isOnline,
			onPress: async () => {
				const promptResult = await run(async () => {
					return await prompts.alert({
						title: t("request_account_deletion"),
						message: t("request_account_deletion_description_non_reversible_will_send_email_first_to_confirm"),
						okText: t("request"),
						cancelText: t("cancel"),
						destructive: true
					})
				})

				if (!promptResult.success) {
					console.error(promptResult.error)
					alerts.error(promptResult.error)

					return
				}

				if (promptResult.data.cancelled) {
					return
				}

				const confirmPromptResult = await run(async () => {
					return await prompts.alert({
						title: t("are_you_sure"),
						message: t("request_account_deletion_description_non_reversible_will_send_email_first_to_confirm_are_you_sure"),
						okText: t("request"),
						cancelText: t("cancel"),
						destructive: true
					})
				})

				if (!confirmPromptResult.success) {
					console.error(confirmPromptResult.error)
					alerts.error(confirmPromptResult.error)

					return
				}

				if (confirmPromptResult.data.cancelled) {
					return
				}

				let twoFactorCode: string | undefined = undefined

				if (accountQuery.data.twoFactorEnabled) {
					const twoFactorPromptResult = await run(async () => {
						return await prompts.input({
							title: t("enter_two_factor_code"),
							message: t("enter_two_factor_code_description_confirm"),
							cancelText: t("cancel"),
							okText: t("request"),
							inputType: "secure-text",
							destructive: true
						})
					})

					if (!twoFactorPromptResult.success) {
						console.error(twoFactorPromptResult.error)
						alerts.error(twoFactorPromptResult.error)

						return
					}

					if (twoFactorPromptResult.data.cancelled || twoFactorPromptResult.data.type !== "string") {
						return
					}

					const twoFactor = twoFactorPromptResult.data.value

					if (twoFactor.length === 0) {
						return
					}

					twoFactorCode = twoFactor
				}

				const result = await runWithLoading(async () => {
					const { authedSdkClient } = await auth.getSdkClients()

					await authedSdkClient.deleteAccount(twoFactorCode)
					await accountQuery.refetch()
				})

				if (!result.success) {
					console.error(result.error)
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
	accountQuery,
	isOnline
}: {
	t: TFunction
	accountQuery: AccountQuerySuccess
	isOnline: boolean
}): Button[] {
	return [
		{
			icon: "time-outline",
			title: t("change_email_address"),
			subTitle: accountQuery.data.email,
			disabled: !isOnline,
			onPress: async () => {
				const newEmailPromptResult = await run(async () => {
					return await prompts.input({
						title: t("change_email_address"),
						message: t("enter_new_email_address"),
						cancelText: t("cancel"),
						okText: t("next")
					})
				})

				if (!newEmailPromptResult.success) {
					console.error(newEmailPromptResult.error)
					alerts.error(newEmailPromptResult.error)

					return
				}

				if (newEmailPromptResult.data.cancelled || newEmailPromptResult.data.type !== "string") {
					return
				}

				const newEmail = newEmailPromptResult.data.value.trim()

				if (newEmail.length === 0) {
					return
				}

				const confirmNewEmailPromptResult = await run(async () => {
					return await prompts.input({
						title: t("change_email_address"),
						message: t("confirm_new_email_address"),
						cancelText: t("cancel"),
						okText: t("next")
					})
				})

				if (!confirmNewEmailPromptResult.success) {
					console.error(confirmNewEmailPromptResult.error)
					alerts.error(confirmNewEmailPromptResult.error)

					return
				}

				if (confirmNewEmailPromptResult.data.cancelled || confirmNewEmailPromptResult.data.type !== "string") {
					return
				}

				const confirmNewEmail = confirmNewEmailPromptResult.data.value.trim()

				if (confirmNewEmail.length === 0) {
					return
				}

				if (newEmail !== confirmNewEmail) {
					alerts.error(t("email_addresses_do_not_match"))

					return
				}

				const passwordPromptResult = await run(async () => {
					return await prompts.input({
						title: t("change_email_address"),
						message: t("enter_password"),
						cancelText: t("cancel"),
						okText: t("save"),
						inputType: "secure-text"
					})
				})

				if (!passwordPromptResult.success) {
					console.error(passwordPromptResult.error)
					alerts.error(passwordPromptResult.error)

					return
				}

				if (passwordPromptResult.data.cancelled || passwordPromptResult.data.type !== "string") {
					return
				}

				const password = passwordPromptResult.data.value

				if (password.length === 0) {
					return
				}

				const result = await runWithLoading(async () => {
					const { authedSdkClient } = await auth.getSdkClients()

					await authedSdkClient.changeEmail(password, newEmail)
					await accountQuery.refetch()
				})

				if (!result.success) {
					console.error(result.error)
					alerts.error(result.error)

					return
				}
			}
		},
		{
			icon: "time-outline",
			title: t("change_nickname"),
			subTitle: accountQuery.data.nickName,
			disabled: !isOnline,
			onPress: async () => {
				const promptResult = await run(async () => {
					return await prompts.input({
						title: t("change_nickname"),
						message: t("enter_nickname"),
						cancelText: t("cancel"),
						okText: t("save"),
						placeholder: accountQuery.data.nickName
					})
				})

				if (!promptResult.success) {
					console.error(promptResult.error)
					alerts.error(promptResult.error)

					return
				}

				if (promptResult.data.cancelled || promptResult.data.type !== "string") {
					return
				}

				const newNickname = promptResult.data.value.trim()

				if (newNickname.length === 0) {
					return
				}

				const result = await runWithLoading(async () => {
					const { authedSdkClient } = await auth.getSdkClients()

					await authedSdkClient.setNickname(newNickname)
					await accountQuery.refetch()
				})

				if (!result.success) {
					console.error(result.error)
					alerts.error(result.error)

					return
				}
			}
		},
		{
			icon: "time-outline",
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
			icon: "time-outline",
			title: t("gdpr_information"),
			subTitle: t("gdpr_information_description"),
			disabled: !isOnline,
			onPress: async () => {
				const result = await runWithLoading(async () => {
					const { authedSdkClient } = await auth.getSdkClients()

					const file = newTmpFile(`gdpr_${accountQuery.data.email}.txt`)

					file.write(JSON.stringify(convertBigInts(await authedSdkClient.getGdprInfo()), null, 4))

					return file
				})

				if (!result.success) {
					console.error(result.error)
					alerts.error(result.error)

					return
				}

				const shareResult = await shareTmpFile({
					uri: result.data.uri,
					name: result.data.name,
					cleanup: () => {
						if (result.data.exists) {
							result.data.delete()
						}
					}
				})

				if (!shareResult.success) {
					console.error(shareResult.error)
					alerts.error(shareResult.error)

					return
				}
			}
		},
		{
			icon: "time-outline",
			title: t("more_account_settings"),
			onPress: async () => {
				const promptResult = await run(async () => {
					return await prompts.alert({
						title: t("open_web_app"),
						message: t("open_web_app_to_change_more_settings_do_you_want_to_open_it"),
						okText: t("open"),
						cancelText: t("cancel")
					})
				})

				if (!promptResult.success) {
					console.error(promptResult.error)
					alerts.error(promptResult.error)

					return
				}

				if (promptResult.data.cancelled) {
					return
				}

				const canOpenResult = await run(async () => {
					return await Linking.canOpenURL("https://app.filen.io/#/settings/account")
				})

				if (!canOpenResult.success) {
					console.error(canOpenResult.error)
					alerts.error(canOpenResult.error)

					return
				}

				if (!canOpenResult.data) {
					alerts.error(t("cannot_open_link"))

					return
				}

				const openResult = await run(async () => {
					return await Linking.openURL("https://app.filen.io/#/settings/account")
				})

				if (!openResult.success) {
					console.error(openResult.error)
					alerts.error(openResult.error)

					return
				}
			}
		}
	]
}

// Account feature toggles (file versioning / login alerts).
export function buildAccountToggleButtons({
	t,
	accountQuery,
	isOnline
}: {
	t: TFunction
	accountQuery: AccountQuerySuccess
	isOnline: boolean
}): Button[] {
	return [
		{
			icon: "time-outline",
			title: t("file_versioning"),
			subTitle: t("file_versioning_description"),
			disabled: !isOnline,
			rightItem: {
				type: "switch",
				value: accountQuery.data.versioningEnabled,
				onValueChange: async () => {
					const result = await runWithLoading(async () => {
						const { authedSdkClient } = await auth.getSdkClients()

						await authedSdkClient.setVersioningEnabled(!accountQuery.data.versioningEnabled)
						await accountQuery.refetch()
					})

					if (!result.success) {
						console.error(result.error)
						alerts.error(result.error)

						return
					}
				}
			}
		},
		{
			icon: "time-outline",
			title: t("login_alerts"),
			subTitle: t("login_alerts_description"),
			disabled: !isOnline,
			rightItem: {
				type: "switch",
				value: accountQuery.data.loginAlertsEnabled,
				onValueChange: async () => {
					const result = await runWithLoading(async () => {
						const { authedSdkClient } = await auth.getSdkClients()

						await authedSdkClient.setLoginAlertsEnabled(!accountQuery.data.loginAlertsEnabled)
						await accountQuery.refetch()
					})

					if (!result.success) {
						console.error(result.error)
						alerts.error(result.error)

						return
					}
				}
			}
		}
	]
}

// 2FA enable / disable switch button. Extracted verbatim from twoFactor.tsx.
export function buildTwoFactorButtons({ t, accountQuery }: { t: TFunction; accountQuery: AccountQuerySuccess }): Button[] {
	return [
		{
			icon: "time-outline",
			title: t("two_factor_authentication"),
			subTitle: t("two_factor_authentication_description"),
			rightItem: {
				type: "switch",
				value: accountQuery.data.twoFactorEnabled,
				onValueChange: async () => {
					if (accountQuery.data.twoFactorEnabled) {
						const promptResult = await run(async () => {
							return await prompts.alert({
								title: t("disable_two_factor_authentication"),
								message: t("disable_two_factor_authentication_description"),
								okText: t("continue"),
								cancelText: t("cancel"),
								destructive: true
							})
						})

						if (!promptResult.success) {
							console.error(promptResult.error)
							alerts.error(promptResult.error)

							return
						}

						if (promptResult.data.cancelled) {
							return
						}

						const twoFactorPromptResult = await run(async () => {
							return await prompts.input({
								title: t("enter_two_factor_code"),
								message: t("enter_two_factor_code_description"),
								cancelText: t("cancel"),
								okText: t("disable"),
								inputType: "secure-text",
								destructive: true
							})
						})

						if (!twoFactorPromptResult.success) {
							console.error(twoFactorPromptResult.error)
							alerts.error(twoFactorPromptResult.error)

							return
						}

						if (twoFactorPromptResult.data.cancelled || twoFactorPromptResult.data.type !== "string") {
							return
						}

						const twoFactor = twoFactorPromptResult.data.value

						if (twoFactor.length === 0) {
							return
						}

						const result = await runWithLoading(async () => {
							await (await auth.getSdkClients()).authedSdkClient.disable2fa(twoFactor)
							await accountQuery.refetch()
						})

						if (!result.success) {
							console.error(result.error)
							alerts.error(result.error)

							return
						}

						return
					}

					const twoFactorPromptResult = await run(async () => {
						return await prompts.input({
							title: t("enter_two_factor_code"),
							message: t("enter_two_factor_code_description"),
							cancelText: t("cancel"),
							okText: t("enable"),
							inputType: "secure-text"
						})
					})

					if (!twoFactorPromptResult.success) {
						console.error(twoFactorPromptResult.error)
						alerts.error(twoFactorPromptResult.error)

						return
					}

					if (twoFactorPromptResult.data.cancelled || twoFactorPromptResult.data.type !== "string") {
						return
					}

					const twoFactor = twoFactorPromptResult.data.value

					if (twoFactor.length === 0) {
						return
					}

					const result = await runWithLoading(async () => {
						const recoverKey = await (await auth.getSdkClients()).authedSdkClient.enable2faGetRecoveryKey(twoFactor)

						await accountQuery.refetch()

						return recoverKey
					})

					if (!result.success) {
						console.error(result.error)
						alerts.error(result.error)

						return
					}

					const recoverKey = result.data

					const promptResult = await run(async () => {
						return await prompts.alert({
							title: t("two_factor_recovery_key"),
							message: t("two_factor_recovery_key_description"),
							okText: t("continue"),
							cancelText: t("close")
						})
					})

					if (!promptResult.success) {
						console.error(promptResult.error)
						alerts.error(promptResult.error)

						return
					}

					const exportResult = await runWithLoading(async () => {
						const file = newTmpFile(`${accountQuery.data.email}.twoFactorRecoveryKey.${Date.now()}.txt`)

						if (file.exists) {
							file.delete()
						}

						file.write(recoverKey)

						return file
					})

					if (!exportResult.success) {
						console.error(exportResult.error)
						alerts.error(exportResult.error)

						return
					}

					const shareResult = await shareTmpFile({
						uri: exportResult.data.uri,
						name: exportResult.data.name,
						cleanup: () => {
							if (exportResult.data.exists) {
								exportResult.data.delete()
							}
						}
					})

					if (!shareResult.success) {
						console.error(shareResult.error)
						alerts.error(shareResult.error)

						return
					}
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
				const promptResult = await run(async () => {
					return await prompts.alert({
						title: t("logout"),
						message: t("logout_confirm_wipes_local_data"),
						okText: t("logout"),
						cancelText: t("cancel"),
						destructive: true
					})
				})

				if (!promptResult.success) {
					console.error(promptResult.error)
					alerts.error(promptResult.error)

					return
				}

				if (promptResult.data.cancelled) {
					return
				}

				const result = await runWithLoading(async () => {
					await auth.logout()
				})

				if (!result.success) {
					console.error(result.error)
					alerts.error(result.error)

					return
				}
			}
		}
	]
}
