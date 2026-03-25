import { useRef, memo } from "react"
import useViewLayout from "@/hooks/useViewLayout"
import View from "@/components/ui/view"
import type { View as RNView } from "react-native"

const Measure = memo(({ children, id }: { children: React.ReactNode; id?: string }) => {
	const viewRef = useRef<RNView>(null)
	const { layout, onLayout } = useViewLayout(viewRef)

	if (!__DEV__) {
		return children
	} else {
		console.log("Measure layout:", id, `WxH ${layout.width}x${layout.height}`)
	}

	return (
		<View
			ref={viewRef}
			onLayout={onLayout}
		>
			{children}
		</View>
	)
})

export default Measure
