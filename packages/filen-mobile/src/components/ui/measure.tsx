import { useRef } from "react"
import useViewLayout from "@/hooks/useViewLayout"
import View from "@/components/ui/view"
import type { LayoutChangeEvent, View as RNView } from "react-native"

const Measure = ({ children, id }: { children: React.ReactNode; id?: string }) => {
	const viewRef = useRef<RNView>(null)
	const { onLayout } = useViewLayout(viewRef)

	if (!__DEV__) {
		return children
	}

	const handleLayout = (e: LayoutChangeEvent) => {
		console.log("Measure layout:", id, `WxH ${e.nativeEvent.layout.width}x${e.nativeEvent.layout.height}`)
		onLayout(e)
	}

	return (
		<View
			ref={viewRef}
			onLayout={handleLayout}
		>
			{children}
		</View>
	)
}

Measure.displayName = "Measure"

export default Measure
