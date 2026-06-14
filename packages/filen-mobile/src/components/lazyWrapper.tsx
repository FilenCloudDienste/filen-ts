import View from "@/components/ui/view"
import { useIsFocused } from "expo-router"
import { useRef } from "react"
import { useResolveClassNames } from "uniwind"
import { ActivityIndicator } from "react-native"

function LazyFallback() {
	const textForeground = useResolveClassNames("text-foreground")

	return (
		<View className="flex-1 flex-row items-center justify-center p-10">
			<ActivityIndicator
				size="small"
				color={textForeground.color}
			/>
		</View>
	)
}

export function LazyWrapper({ children, disabled = false }: { children: React.ReactNode; disabled?: boolean }) {
	const isFocused = useIsFocused()
	const didFocusOnce = useRef(false)

	if (isFocused) {
		// eslint-disable-next-line react-hooks/refs
		didFocusOnce.current = true
	}

	if (disabled) {
		return children
	}

	// eslint-disable-next-line react-hooks/refs
	if (!didFocusOnce.current) {
		return <LazyFallback />
	}

	return children
}
