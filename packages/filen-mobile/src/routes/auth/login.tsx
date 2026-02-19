import View from "@/components/ui/view"
import Text from "@/components/ui/text"
import { Fragment } from "react"
import SafeAreaView from "@/components/ui/safeAreaView"
import Header from "@/components/ui/header"
import auth from "@/lib/auth"
import { TextInput } from "react-native"
import Button from "@/components/ui/button"
import { useRouter } from "expo-router"
import { memo } from "@/lib/memo"

export const Login = memo(() => {
	const router = useRouter()

	return (
		<Fragment>
			<Header title="Login" />
			<SafeAreaView edges={["left", "right"]}>
				<View className="gap-4">
					<Text>Welcome to the Login Page!</Text>
					<TextInput placeholder="Email" />
					<TextInput
						placeholder="Password"
						secureTextEntry
					/>
					<Button
						onPress={async () => {
							await auth.login({
								email: process.env["EXPO_PUBLIC_EMAIL"],
								password: process.env["EXPO_PUBLIC_PASSWORD"],
								twoFactorCode: undefined
							})

							const { authedSdkClient } = await auth.getSdkClients()

							router.replace({
								pathname: "/tabs/drive/[uuid]",
								params: {
									uuid: authedSdkClient.root().uuid
								}
							})
						}}
					>
						Login
					</Button>
				</View>
			</SafeAreaView>
		</Fragment>
	)
})

export default Login
