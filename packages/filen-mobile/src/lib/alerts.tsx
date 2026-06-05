import * as Burnt from "burnt"
import { Notifier, NotifierComponents } from "react-native-notifier"
import View from "@/components/ui/view"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { memo } from "react"
import { unwrapSdkError, unwrappedSdkErrorToHumanReadable } from "@/lib/sdkErrors"
import i18n from "@/lib/i18n"

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

// Plain object namespace (no instance state) — toast/error-banner helpers. Kept as a
// single exported object so the ~73 `alerts.error(...)` / `alerts.normal(...)` call sites
// stay unchanged; the former `class Alerts` added no value (zero fields, zero `this`).
export const alerts = {
	error(message: unknown): void {
		const unwrappedSdkError = unwrapSdkError(message)
		const description = unwrappedSdkError
			? unwrappedSdkErrorToHumanReadable(unwrappedSdkError)
			: message instanceof Error
				? message.message
				: String(message)

		Notifier.showNotification({
			title: i18n.t("error"),
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
	},
	normal(title: string): void {
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

export default alerts
