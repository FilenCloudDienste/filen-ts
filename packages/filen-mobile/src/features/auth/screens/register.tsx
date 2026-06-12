import { Fragment, useState } from "react"
import { Platform, TextInput } from "react-native"
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
import { isValidEmail } from "@/features/auth/utils"
import { hairlineHeight } from "@/lib/hairline"

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

const Register = () => {
	const { t } = useTranslation()
	const navigation = useNavigation()
	const textForeground = useResolveClassNames("text-foreground")
	const textMutedForeground = useResolveClassNames("text-muted-foreground")
	const textBlue500 = useResolveClassNames("text-blue-500")
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const [email, setEmail] = useState<string>("")
	const [password, setPassword] = useState<string>("")
	const [confirmPassword, setConfirmPassword] = useState<string>("")
	const isOnline = useIsOnline()

	const passwordStrength = password.length > 0 ? ratePasswordStrength(password) : null
	const emailValid = isValidEmail(email)
	const passwordsMatch = password.length > 0 && password === confirmPassword
	const canSubmit = emailValid && passwordsMatch && passwordStrength !== null && isOnline

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
			console.error(result.error)
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
			console.error(promptResult.error)
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
			console.error(result.error)
			alerts.error(result.error)

			return
		}

		alerts.normal(t("resend_confirmation_email_sent"))
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
				className="flex-1 bg-background-secondary"
				edges={["left", "right", "bottom"]}
			>
				<KeyboardAwareScrollView
					className="flex-1 bg-background-secondary"
					contentContainerClassName={cn("px-4 gap-6", Platform.OS === "ios" && "pt-8")}
					keyboardShouldPersistTaps="handled"
					contentInsetAdjustmentBehavior="automatic"
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
						<View
							className="bg-separator ml-12"
							style={hairlineHeight}
						/>
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
						<View
							className="bg-separator ml-12"
							style={hairlineHeight}
						/>
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
				</KeyboardAwareScrollView>
			</SafeAreaView>
		</Fragment>
	)
}

export default Register
