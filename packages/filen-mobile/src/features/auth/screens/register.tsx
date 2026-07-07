import { Fragment, useState } from "react"
import { Linking, Platform, TextInput } from "react-native"
import { Trans, useTranslation } from "react-i18next"
import { useNavigation } from "expo-router"
import { useResolveClassNames } from "uniwind"
import { cn, ratePasswordStrength, run } from "@filen/utils"
import Ionicons from "@expo/vector-icons/Ionicons"
import SafeAreaView from "@/components/ui/safeAreaView"
import Header from "@/components/ui/header"
import View, { KeyboardAwareScrollView } from "@/components/ui/view"
import Text from "@/components/ui/text"
import { PressableOpacity } from "@/components/ui/pressables"
import auth from "@/lib/auth"
import alerts from "@/lib/alerts"
import prompts from "@/lib/prompts"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import useIsOnline from "@/hooks/useIsOnline"
import { isValidEmail, isPasswordStrongEnough } from "@/features/auth/utils"
import useRegisterCheckQuery from "@/features/auth/queries/useRegisterCheck.query"
import logger from "@/lib/logger"

type PasswordStrength = ReturnType<typeof ratePasswordStrength>["strength"]

// Strength → catalog key. Resolved with `t()` at the call site (inside the component, where the
// hook `t` is in scope), so the labels stay reactive to language switches. The values are catalog
// key literals — not template-literal keys — to keep full key-type-safety.
const STRENGTH_LABEL_KEY: Record<
	PasswordStrength,
	"password_strength_weak" | "password_strength_normal" | "password_strength_strong" | "password_strength_best"
> = {
	weak: "password_strength_weak",
	normal: "password_strength_normal",
	strong: "password_strength_strong",
	best: "password_strength_best"
}

const STRENGTH_TW: Record<PasswordStrength, string> = {
	weak: "text-red-500",
	normal: "text-yellow-500",
	strong: "text-blue-500",
	best: "text-green-500"
}

// Explainer article for the "free 10 GiB at signup" eligibility check (same URL as filen-web).
const LEARN_MORE_URL = "https://filen.io/hub/free-10-gb-at-signup-eligibility-check-before-creating-an-account/"

const Register = () => {
	const { t } = useTranslation()
	const navigation = useNavigation()
	const textForeground = useResolveClassNames("text-foreground")
	const textMutedForeground = useResolveClassNames("text-muted-foreground")
	const textBlue500 = useResolveClassNames("text-blue-500")
	const textGreen500 = useResolveClassNames("text-green-500")
	const textRed500 = useResolveClassNames("text-red-500")
	const textPrimary = useResolveClassNames("text-primary")
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const [email, setEmail] = useState<string>("")
	const [password, setPassword] = useState<string>("")
	const [confirmPassword, setConfirmPassword] = useState<string>("")
	const isOnline = useIsOnline()
	const registerCheckQuery = useRegisterCheckQuery()

	const passwordStrength = password.length > 0 ? ratePasswordStrength(password) : null
	const emailValid = isValidEmail(email)
	const passwordsMatch = password.length > 0 && password === confirmPassword
	const passwordStrongEnough = isPasswordStrongEnough(passwordStrength)
	const canSubmit = emailValid && passwordsMatch && passwordStrongEnough && isOnline

	const dismiss = (): void => {
		navigation.getParent()?.goBack()
	}

	const handleRegister = async (): Promise<void> => {
		if (!canSubmit) {
			return
		}

		const result = await runWithLoading(async () => {
			await auth.register({
				email: email.trim(),
				password,
				refId: undefined,
				affId: undefined
			})
		})

		if (!result.success) {
			logger.warn("auth", "registration failed", { error: result.error })
			alerts.error(result.error)

			return
		}

		dismiss()

		alerts.normal(t("account_created"))
	}

	const handleResendConfirmation = async (): Promise<void> => {
		if (!isOnline) {
			return
		}

		const promptResult = await run(async () => {
			return await prompts.input({
				title: t("resend_confirmation_email"),
				message: t("enter_registered_email"),
				placeholder: t("email_placeholder_hint"),
				cancelText: t("cancel"),
				okText: t("resend"),
				defaultValue: email.trim()
			})
		})

		if (!promptResult.success) {
			logger.warn("auth", "resend confirmation prompt failed", { error: promptResult.error })
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
			await auth.resendConfirmationEmail(targetEmail)
		})

		if (!result.success) {
			logger.warn("auth", "resend confirmation email failed", { error: result.error })
			alerts.error(result.error)

			return
		}

		alerts.normal(t("resend_confirmation_email_sent"))
	}

	const handleLearnMore = async (): Promise<void> => {
		const result = await run(async () => {
			return await Linking.openURL(LEARN_MORE_URL)
		})

		if (!result.success) {
			logger.error("auth", "failed to open free-storage learn-more link", { error: result.error })
		}
	}

	return (
		<Fragment>
			<Header
				title={t("register")}
				transparent={Platform.OS === "ios"}
				shadowVisible={false}
				backVisible={Platform.OS === "android"}
				backgroundColor={Platform.select({
					ios: undefined,
					default: bgBackgroundSecondary.backgroundColor as string
				})}
				leftItems={Platform.select({
					ios: [
						{
							type: "button",
							icon: {
								name: "close",
								color: textForeground.color,
								size: 20
							},
							props: {
								onPress: dismiss
							}
						}
					],
					default: undefined
				})}
				rightItems={() => {
					if (!canSubmit) {
						return null
					}

					return [
						{
							type: "button",
							icon: {
								name: "checkmark-outline",
								color: textBlue500.color,
								size: 20
							},
							props: {
								onPress: handleRegister
							}
						}
					]
				}}
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
					<View className="gap-1 pt-2 bg-transparent">
						<Text className="text-foreground text-2xl font-bold">{t("create_account_welcome")}</Text>
						<Text className="text-muted-foreground text-sm">{t("register_subtitle")}</Text>
					</View>
					<View className="bg-transparent rounded-2xl overflow-hidden">
						<View className="flex-row items-center px-4 bg-transparent">
							<Ionicons
								name="mail-outline"
								size={18}
								color={textMutedForeground.color}
							/>
							<TextInput
								className="text-foreground text-base flex-1 py-4 pl-3 leading-5"
								placeholderTextColor={textMutedForeground.color as string}
								placeholder={t("email")}
								keyboardType="email-address"
								autoCapitalize="none"
								autoComplete="email"
								autoCorrect={false}
								textContentType="emailAddress"
								returnKeyType="next"
								value={email}
								onChangeText={setEmail}
							/>
						</View>
						<View className="h-px bg-separator ml-12" />
						<View className="flex-row items-center px-4 bg-transparent">
							<Ionicons
								name="lock-closed-outline"
								size={18}
								color={textMutedForeground.color}
							/>
							<TextInput
								className="text-foreground text-base flex-1 py-4 pl-3 leading-5"
								placeholderTextColor={textMutedForeground.color as string}
								placeholder={t("password")}
								secureTextEntry
								autoCapitalize="none"
								autoComplete="new-password"
								autoCorrect={false}
								textContentType="newPassword"
								returnKeyType="next"
								value={password}
								onChangeText={setPassword}
							/>
						</View>
						<View className="h-px bg-separator ml-12" />
						<View className="flex-row items-center px-4 bg-transparent">
							<Ionicons
								name="lock-closed-outline"
								size={18}
								color={textMutedForeground.color}
							/>
							<TextInput
								className="text-foreground text-base flex-1 py-4 pl-3 leading-5"
								placeholderTextColor={textMutedForeground.color as string}
								placeholder={t("confirm_password")}
								secureTextEntry
								autoCapitalize="none"
								autoComplete="new-password"
								autoCorrect={false}
								textContentType="newPassword"
								returnKeyType="go"
								value={confirmPassword}
								onChangeText={setConfirmPassword}
								onSubmitEditing={handleRegister}
							/>
						</View>
					</View>
					{passwordStrength !== null && (
						<View className="flex-row items-center justify-between px-1 bg-transparent">
							<Text className="text-muted-foreground text-xs">{t("password_strength")}</Text>
							<Text className={cn("text-xs font-medium", STRENGTH_TW[passwordStrength.strength])}>
								{t(STRENGTH_LABEL_KEY[passwordStrength.strength])}
							</Text>
						</View>
					)}
					{passwordStrength !== null && !passwordStrongEnough && (
						<Text className="text-red-500 text-xs px-1">{t("password_too_weak_to_register")}</Text>
					)}
					{password.length > 0 && confirmPassword.length > 0 && !passwordsMatch && (
						<Text className="text-red-500 text-xs px-1">{t("passwords_do_not_match")}</Text>
					)}
					<View className="px-4 pb-2 pt-2 gap-3 bg-transparent">
						<PressableOpacity
							onPress={handleRegister}
							enabled={canSubmit}
							className={cn("bg-primary rounded-2xl py-3 items-center justify-center", !canSubmit && "opacity-50")}
						>
							<Text className="text-primary-foreground text-base font-semibold">{t("create_account")}</Text>
						</PressableOpacity>
						<PressableOpacity
							onPress={handleResendConfirmation}
							enabled={isOnline}
							className={cn(!isOnline && "opacity-50 pointer-events-none")}
						>
							<Text className="text-primary text-sm text-center">{t("resend_confirmation_email")}</Text>
						</PressableOpacity>
					</View>
					<PressableOpacity onPress={dismiss}>
						<Text className="text-muted-foreground text-sm text-center">
							<Trans
								i18nKey="already_have_an_account"
								components={{
									link: (
										<Text
											className="text-primary"
											onPress={dismiss}
										/>
									)
								}}
							/>
						</Text>
					</PressableOpacity>
					{registerCheckQuery.status === "success" && (
						<View className="flex-row items-center gap-3 rounded-2xl bg-background-tertiary px-4 py-3">
							<Ionicons
								name={registerCheckQuery.data.ok ? "checkmark-circle" : "close-circle"}
								size={20}
								color={(registerCheckQuery.data.ok ? textGreen500.color : textRed500.color) as string}
							/>
							<Text className="text-muted-foreground text-sm flex-1">
								{registerCheckQuery.data.ok ? t("register_free_storage_eligible") : t("register_free_storage_not_eligible")}
							</Text>
							<PressableOpacity
								onPress={handleLearnMore}
								className="flex-row items-center gap-1"
							>
								<Text className="text-primary text-sm">{t("register_free_storage_learn_more")}</Text>
								<Ionicons
									name="chevron-forward"
									size={14}
									color={textPrimary.color as string}
								/>
							</PressableOpacity>
						</View>
					)}
				</KeyboardAwareScrollView>
			</SafeAreaView>
		</Fragment>
	)
}

export default Register
