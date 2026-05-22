import { Fragment, memo, useState } from "react"
import { Platform, TextInput, Image } from "react-native"
import { router } from "expo-router"
import { useResolveClassNames } from "uniwind"
import { cn, run } from "@filen/utils"
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
import { unwrapSdkError } from "@/lib/utils"
import useIsOnline from "@/hooks/useIsOnline"
import { reloadAppAsync } from "expo"
import { ErrorKind } from "@filen/sdk-rs"

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function isValidEmail(email: string): boolean {
	return EMAIL_REGEX.test(email.trim())
}

function isTwoFactorRequiredError(error: unknown): boolean {
	const unwrapped = unwrapSdkError(error)

	if (!unwrapped) {
		return false
	}

	if (unwrapped.kind() === ErrorKind.Enter2fa || unwrapped.kind() === ErrorKind.Wrong2fa) {
		return true
	}

	const message = unwrapped.message().toLowerCase()

	return message.includes("2fa") || message.includes("two factor") || message.includes("twofactor")
}

const Login = memo(() => {
	const textMutedForeground = useResolveClassNames("text-muted-foreground")
	const isOnline = useIsOnline()
	const [email, setEmail] = useState<string>("")
	const [password, setPassword] = useState<string>("")

	const canSubmit = isValidEmail(email) && password.length > 0 && isOnline

	const finishLogin = async () => {
		const result = await runWithLoading(async () => {
			await reloadAppAsync()
		})

		if (!result.success) {
			console.error(result.error)
			alerts.error(result.error)

			return
		}
	}

	const promptForTwoFactor = async (): Promise<string | null> => {
		const promptResult = await run(async () => {
			return await prompts.input({
				title: "tbd_two_factor_authentication",
				message: "tbd_enter_two_factor_code_or_recovery_key",
				inputType: "plain-text",
				placeholder: "tbd_code_or_recovery_key",
				cancelText: "tbd_cancel",
				okText: "tbd_sign_in"
			})
		})

		if (!promptResult.success) {
			console.error(promptResult.error)
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
			console.error(firstAttempt.error)
			alerts.error(firstAttempt.error)

			return
		}

		const twoFactorCode = await promptForTwoFactor()

		if (!twoFactorCode) {
			return
		}

		const secondAttempt = await runWithLoading(async () => {
			await auth.login({
				email: trimmedEmail,
				password,
				twoFactorCode
			})
		})

		if (!secondAttempt.success) {
			console.error(secondAttempt.error)
			alerts.error(secondAttempt.error)

			return
		}

		await finishLogin()
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
				title: "tbd_reset_password",
				message: "tbd_enter_account_email",
				placeholder: "tbd_email_placeholder_hint",
				cancelText: "tbd_cancel",
				okText: "tbd_send",
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
			alerts.error("tbd_please_enter_valid_email")

			return
		}

		const result = await runWithLoading(async () => {
			await auth.startPasswordReset(targetEmail)
		})

		if (!result.success) {
			console.error(result.error)
			alerts.error(result.error)

			return
		}

		alerts.normal("tbd_password_reset_email_sent")
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
				className="flex-1"
				edges={["left", "right", "bottom"]}
			>
				<KeyboardAwareScrollView
					className="flex-1"
					contentContainerClassName="px-4 gap-6 pt-4"
					keyboardShouldPersistTaps="handled"
					contentInsetAdjustmentBehavior="automatic"
				>
					<View className="items-center gap-3 pt-6">
						<Image
							source={require("@/assets/images/icon.png")}
							className="size-20 rounded-2xl"
						/>
						<Text className="text-foreground text-3xl font-bold">tbd_welcome_back</Text>
						<Text className="text-muted-foreground text-sm text-center">tbd_sign_in_to_your_account</Text>
					</View>
					<View className="bg-background-secondary rounded-2xl overflow-hidden">
						<View className="flex-row items-center px-4">
							<Ionicons
								name="mail-outline"
								size={18}
								color={textMutedForeground.color}
							/>
							<TextInput
								className="text-foreground text-base flex-1 py-4 pl-3 leading-5"
								placeholderTextColor={textMutedForeground.color as string}
								placeholder="tbd_email"
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
						<View className="h-px bg-border ml-12" />
						<View className="flex-row items-center px-4">
							<Ionicons
								name="lock-closed-outline"
								size={18}
								color={textMutedForeground.color}
							/>
							<TextInput
								className="text-foreground text-base flex-1 py-4 pl-3 leading-5"
								placeholderTextColor={textMutedForeground.color as string}
								placeholder="tbd_password"
								secureTextEntry
								autoCapitalize="none"
								autoComplete="current-password"
								autoCorrect={false}
								textContentType="password"
								returnKeyType="go"
								value={password}
								onChangeText={setPassword}
								onSubmitEditing={handleLogin}
							/>
						</View>
					</View>
					<View className="px-4 pb-2 pt-2 gap-3">
						<PressableOpacity
							onPress={handleLogin}
							enabled={canSubmit}
							className={cn("bg-primary rounded-2xl py-3 items-center justify-center", !canSubmit && "opacity-50")}
						>
							<Text className="text-primary-foreground text-base font-semibold">tbd_sign_in</Text>
						</PressableOpacity>
						<PressableOpacity
							onPress={handleForgotPassword}
							enabled={isOnline}
							className={cn(!isOnline && "opacity-50 pointer-events-none")}
						>
							<Text className="text-primary text-sm text-center">tbd_forgot_password</Text>
						</PressableOpacity>
					</View>
					<PressableOpacity onPress={openRegister}>
						<Text className="text-muted-foreground text-sm text-center">
							tbd_dont_have_an_account <Text className="text-primary">tbd_create_one</Text>
						</Text>
					</PressableOpacity>
				</KeyboardAwareScrollView>
			</SafeAreaView>
		</Fragment>
	)
})

export default Login
