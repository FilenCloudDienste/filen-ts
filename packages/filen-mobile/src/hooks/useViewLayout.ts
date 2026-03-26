import type { View, LayoutChangeEvent } from "react-native"
import { useState, useCallback } from "react"

export default function useViewLayout(ref: React.RefObject<View | null>) {
	const [layout, setLayout] = useState<{
		width: number
		height: number
		x: number
		y: number
	}>({
		width: 0,
		height: 0,
		x: 0,
		y: 0
	})

	const onLayout = useCallback(
		(e?: LayoutChangeEvent) => {
			if (e) {
				const { layout } = e.nativeEvent

				setLayout({
					width: layout.width,
					height: layout.height,
					x: layout.x,
					y: layout.y
				})

				return
			}

			ref?.current?.measureInWindow?.((x, y, width, height) => {
				setLayout({
					width,
					height,
					x,
					y
				})
			})
		},
		[ref]
	)

	return {
		layout,
		onLayout
	}
}
