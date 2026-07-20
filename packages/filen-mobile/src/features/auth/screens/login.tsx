import { Fragment, useState } from "react"
import { Platform, Image } from "react-native"
import { Trans, useTranslation } from "react-i18next"
import { router } from "@/lib/router"
import { useResolveClassNames, useUniwind } from "uniwind"
import { cn, run } from "@filen/utils"
import SafeAreaView from "@/components/ui/safeAreaView"
import Header from "@/components/ui/header"
import View, { KeyboardAwareScrollView } from "@/components/ui/view"
import Text from "@/components/ui/text"
import { PressableOpacity } from "@/components/ui/pressables"
import IconTextField from "@/components/ui/iconTextField"
import auth from "@/lib/auth"
import alerts from "@/lib/alerts"
import prompts from "@/lib/prompts"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import { unwrapSdkError } from "@/lib/sdkErrors"
import useIsOnline from "@/hooks/useIsOnline"
import { reloadAppAsync } from "expo"
import { ErrorKind } from "@filen/sdk-rs"
import { isValidEmail } from "@/features/auth/utils"
import logger from "@/lib/logger"

function isTwoFactorRequiredError(error: unknown): boolean {
	const unwrapped = unwrapSdkError(error)

	if (!unwrapped) {
		return false
	}

	if (unwrapped.kind() === ErrorKind.Enter2fa || unwrapped.kind() === ErrorKind.Wrong2fa) {
		return true
	}

	// Fallback when the kind isn't set: the SDK 0.4.26 server code is exact — no brittle
	// message-substring matching.
	const serverCode = unwrapped.serverCode()

	return serverCode === "enter_2fa" || serverCode === "wrong_2fa"
}

const Login = () => {
	const { t } = useTranslation()
	const textMutedForeground = useResolveClassNames("text-muted-foreground")
	const isOnline = useIsOnline()
	const [email, setEmail] = useState<string>("")
	const { theme } = useUniwind()
	const [password, setPassword] = useState<string>("")

	const canSubmit = isValidEmail(email) && password.length > 0 && isOnline

	const finishLogin = async () => {
		const result = await runWithLoading(async () => {
			// The reload kills the JS proxies of the just-created SDK clients but would leak
			// their Rust Arcs (uniffi handles have no GC) — destroy them first; the
			// post-reload boot reconstructs from the persisted config.
			auth.prepareForReload()

			await reloadAppAsync()
		})

		if (!result.success) {
			logger.warn("auth", "app reload after login failed", { error: result.error })

			// The process keeps running with persisted credentials: rebuild the clients
			// prepareForReload tore down so the authenticated UI doesn't hang on the re-armed
			// clientsReady latch until a manual restart.
			const recovery = await run(async () => {
				await auth.recoverAfterFailedReload()
			})

			if (!recovery.success) {
				logger.error("auth", "recovery after failed reload failed", { error: recovery.error })
			}

			alerts.error(result.error)

			return
		}
	}

	const promptForTwoFactor = async (wrongCode: boolean): Promise<string | null> => {
		const promptResult = await run(async () => {
			return await prompts.input({
				title: t("two_factor_authentication"),
				message: wrongCode ? t("incorrect_two_factor_code_try_again") : t("enter_two_factor_code_or_recovery_key"),
				inputType: "plain-text",
				placeholder: t("code_or_recovery_key"),
				cancelText: t("cancel"),
				okText: t("sign_in")
			})
		})

		if (!promptResult.success) {
			logger.warn("auth", "two-factor prompt failed", { error: promptResult.error })
			alerts.error(promptResult.error)

			return null
		}

		if (promptResult.data.cancelled || promptResult.data.type !== "string") {
			return null
		}

		const code = promptResult.data.value.trim()

		return code.length > 0 ? code : null
	}

	const handleLogin = async (): Promise<void> => {
		if (!canSubmit) {
			return
		}

		const trimmedEmail = email.trim()

		const firstAttempt = await runWithLoading(async () => {
			await auth.login({
				email: trimmedEmail,
				password,
				twoFactorCode: undefined
			})
		})

		if (firstAttempt.success) {
			await finishLogin()

			return
		}

		if (!isTwoFactorRequiredError(firstAttempt.error)) {
			logger.warn("auth", "login failed", { error: firstAttempt.error })
			alerts.error(firstAttempt.error)

			return
		}

		// 2FA required. Prompt and retry; on a rejected code, re-prompt with a hint instead of
		// dropping back to the Sign In button. Cancelling the prompt exits the flow.
		let wrongCode = false

		for (;;) {
			const twoFactorCode = await promptForTwoFactor(wrongCode)

			if (!twoFactorCode) {
				return
			}

			const attempt = await runWithLoading(async () => {
				await auth.login({
					email: trimmedEmail,
					password,
					twoFactorCode
				})
			})

			if (attempt.success) {
				await finishLogin()

				return
			}

			// A 2FA error after a code was submitted means it was wrong/expired → re-prompt with a
			// hint. Any other failure is real → surface it and stop.
			if (!isTwoFactorRequiredError(attempt.error)) {
				logger.warn("auth", "login with 2FA failed", { error: attempt.error })
				alerts.error(attempt.error)

				return
			}

			wrongCode = true
		}
	}

	const handleForgotPassword = async (): Promise<void> => {
		// Defense in depth: PressableOpacity is gated on hasInternet, but if
		// it fires through any other path (race during NetInfo flip, keyboard
		// shortcut, etc.) we still want the SDK call to no-op.
		if (!isOnline) {
			return
		}

		const promptResult = await run(async () => {
			return await prompts.input({
				title: t("reset_password"),
				message: t("enter_account_email"),
				placeholder: t("email_placeholder_hint"),
				cancelText: t("cancel"),
				okText: t("send"),
				defaultValue: email.trim()
			})
		})

		if (!promptResult.success) {
			logger.warn("auth", "reset password prompt failed", { error: promptResult.error })
			alerts.error(promptResult.error)

			return
		}

		if (promptResult.data.cancelled || promptResult.data.type !== "string") {
			return
		}

		const targetEmail = promptResult.data.value.trim()

		if (!isValidEmail(targetEmail)) {
			alerts.error(t("please_enter_valid_email"))

			return
		}

		const result = await runWithLoading(async () => {
			await auth.startPasswordReset(targetEmail)
		})

		if (!result.success) {
			logger.warn("auth", "password reset request failed", { error: result.error })
			alerts.error(result.error)

			return
		}

		alerts.normal(t("password_reset_email_sent"))
	}

	const openRegister = (): void => {
		router.push("/register")
	}

	return (
		<Fragment>
			<Header
				title=""
				transparent={Platform.OS === "ios"}
				shadowVisible={false}
				backVisible={false}
			/>
			<SafeAreaView
				className="flex-1 bg-background"
				edges={["left", "right", "bottom"]}
			>
				<KeyboardAwareScrollView
					className="flex-1"
					contentContainerClassName="px-4 gap-6 py-8 bg-background"
					keyboardShouldPersistTaps="handled"
					contentInsetAdjustmentBehavior="automatic"
					scrollEnabled={true}
				>
					<View className="items-center gap-3 pt-6">
						<Image
							source={theme === "dark" ? require("@/assets/images/icon-dark.png") : require("@/assets/images/icon-light.png")}
							className="size-20 rounded-2xl"
						/>
						<Text className="text-foreground text-3xl font-bold">{t("welcome_back")}</Text>
						<Text className="text-muted-foreground text-sm text-center">{t("sign_in_to_your_account")}</Text>
					</View>
					<View className="bg-background-secondary rounded-2xl overflow-hidden">
						<IconTextField
							icon="mail-outline"
							iconColor={textMutedForeground.color as string}
							showDividerBelow
							placeholderTextColor={textMutedForeground.color as string}
							placeholder={t("email")}
							keyboardType="email-address"
							autoCapitalize="none"
							autoComplete="email"
							autoCorrect={false}
							// "username", not "emailAddress": Password AutoFill only pairs a credential
							// (and shows the QuickType suggestion) for username+password fields — an
							// emailAddress field gets contact-email suggestions instead.
							textContentType="username"
							importantForAutofill="yes"
							returnKeyType="next"
							value={email}
							onChangeText={setEmail}
						/>
						<IconTextField
							icon="lock-closed-outline"
							iconColor={textMutedForeground.color as string}
							placeholderTextColor={textMutedForeground.color as string}
							placeholder={t("password")}
							secureTextEntry
							autoCapitalize="none"
							autoComplete="current-password"
							autoCorrect={false}
							textContentType="password"
							importantForAutofill="yes"
							returnKeyType="go"
							value={password}
							onChangeText={setPassword}
							onSubmitEditing={handleLogin}
						/>
					</View>
					<View className="px-4 pb-2 pt-2 gap-3">
						<PressableOpacity
							onPress={handleLogin}
							enabled={canSubmit}
							className={cn("bg-primary rounded-2xl py-3 items-center justify-center", !canSubmit && "opacity-50")}
						>
							<Text className="text-primary-foreground text-base font-semibold">{t("sign_in")}</Text>
						</PressableOpacity>
						<PressableOpacity
							onPress={handleForgotPassword}
							enabled={isOnline}
							className={cn(!isOnline && "opacity-50 pointer-events-none")}
						>
							<Text className="text-primary text-sm text-center">{t("forgot_password")}</Text>
						</PressableOpacity>
					</View>
					<PressableOpacity onPress={openRegister}>
						<Text className="text-muted-foreground text-sm text-center">
							<Trans
								i18nKey="dont_have_an_account"
								components={{
									link: (
										<Text
											className="text-primary"
											onPress={openRegister}
										/>
									)
								}}
							/>
						</Text>
					</PressableOpacity>
				</KeyboardAwareScrollView>
			</SafeAreaView>
		</Fragment>
	)
}

export default Login
