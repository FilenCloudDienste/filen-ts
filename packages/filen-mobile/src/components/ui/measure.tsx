import { useRef } from "react"
import useViewLayout from "@/hooks/useViewLayout"
import View from "@/components/ui/view"
import type { LayoutChangeEvent, View as RNView } from "react-native"
import logger from "@/lib/logger"

const Measure = ({ children, id }: { children: React.ReactNode; id?: string }) => {
	const viewRef = useRef<RNView>(null)
	const { onLayout } = useViewLayout(viewRef)

	if (!__DEV__) {
		return children
	}

	const handleLayout = (e: LayoutChangeEvent) => {
		logger.debug("ui", "Measure layout", { id, width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })
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
