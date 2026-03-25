import * as Burnt from "burnt"
import { Notifier, NotifierComponents } from "react-native-notifier"
import View from "@/components/ui/view"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { memo } from "react"
import { FilenSdkError } from "@filen/sdk-rs"

const NotifierErrorContainer = memo(({ children }: { children: React.ReactNode }) => {
	const insets = useSafeAreaInsets()

	return (
		<View
			style={{
				paddingTop: insets.top
			}}
			className="bg-red-500 z-1000 absolute top-0 left-0 right-0"
		>
			{children}
		</View>
	)
})

export class Alerts {
	public error(message: unknown): void {
		const description = FilenSdkError.hasInner(message)
			? FilenSdkError.getInner(message).message()
			: message instanceof Error
				? message.message
				: String(message)

		Notifier.showNotification({
			title: "Error",
			description,
			duration: 3000,
			Component: NotifierComponents.Alert,
			componentProps: {
				alertType: "error",
				ContainerComponent: NotifierErrorContainer,
				maxDescriptionLines: 16,
				maxTitleLines: 1
			},
			containerStyle: {
				zIndex: 1000
			}
		})
	}

	public normal(title: string): void {
		Burnt.toast({
			title,
			duration: 3,
			preset: "done",
			shouldDismissByDrag: true,
			from: "bottom",
			haptic: "none"
		})
	}
}

export const alerts = new Alerts()

export default alerts
