import type { LayoutChangeEvent } from "react-native"
import { useState } from "react"

export default function useViewLayout() {
	const [layout, setLayout] = useState<{
		width: number
		height: number
	}>({
		width: 0,
		height: 0
	})

	const onLayout = (e: LayoutChangeEvent) => {
		const { width, height } = e.nativeEvent.layout

		// Position-only layout passes keep the same state object, so React bails out of the update.
		setLayout(prev => (prev.width === width && prev.height === height ? prev : { width, height }))
	}

	return {
		layout,
		onLayout
	}
}
