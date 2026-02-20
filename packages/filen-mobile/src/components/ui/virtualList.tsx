import { useRef, useState } from "react"
import { withUniwind, useResolveClassNames } from "uniwind"
import { type View as RNView, RefreshControl, ActivityIndicator, useWindowDimensions } from "react-native"
import View from "@/components/ui/view"
import useViewLayout from "@/hooks/useViewLayout"
import { cn, run, type DeferFn } from "@filen/utils"
import alerts from "@/lib/alerts"
import { AnimatedView } from "@/components/ui/animated"
import { FadeOut } from "react-native-reanimated"
import { memo, useCallback, useMemo } from "@/lib/memo"
import {
	FlashList,
	type FlashListProps,
	type FlashListRef,
	type ListRenderItemInfo as FlashListListRenderItemInfo
} from "@shopify/flash-list"

export type ListRenderItemInfo<T> = FlashListListRenderItemInfo<T>

export type ListRef<T> = FlashListRef<T>

export type VirtualListExtraProps = {
	itemHeight?: number
	parentClassName?: string
	onRefresh?: (defer: DeferFn) => Promise<void> | void
	grid?: boolean
	itemWidth?: number
	itemsPerRow?: number
	loading?: boolean
	emptyComponent?: () => React.ReactNode
	footerComponent?: () => React.ReactNode
	headerComponent?: () => React.ReactNode
}

export const VirtualListInner = memo(<T,>(props: FlashListProps<T> & React.RefAttributes<ListRef<T>> & VirtualListExtraProps) => {
	const viewRef = useRef<RNView>(null)
	const { layout, onLayout } = useViewLayout(viewRef)
	const [refreshing, setRefreshing] = useState<boolean>(false)
	const textForeground = useResolveClassNames("text-foreground")
	const windowDimensions = useWindowDimensions()

	const itemsPerRow = useMemo(() => {
		if (props.itemsPerRow) {
			return props.itemsPerRow
		}

		if (!props.grid || !props.itemWidth) {
			return 1
		}

		return Math.round(Math.max(1, Math.round(layout.width / props.itemWidth)))
	}, [props.grid, props.itemWidth, layout, props.itemsPerRow])

	const onRefresh = useCallback(async () => {
		if (!props.onRefresh) {
			return
		}

		const result = await run(async defer => {
			setRefreshing(true)

			defer(() => {
				setRefreshing(false)
			})

			await props.onRefresh?.(defer)
		})

		if (!result.success) {
			console.error(result.error)
			alerts.error(result.error)
		}
	}, [props])

	const refreshControl = useMemo(() => {
		if (!props.onRefresh) {
			return undefined
		}

		return (
			<RefreshControl
				refreshing={refreshing}
				onRefresh={onRefresh}
			/>
		)
	}, [props, refreshing, onRefresh])

	const emptyComponent = useMemo(() => {
		if (props.loading) {
			return null
		}

		if (props.emptyComponent) {
			return (
				<View
					className="flex-1 bg-transparent"
					style={{
						width: layout.width,
						height: layout.height
					}}
				>
					{props.emptyComponent()}
				</View>
			)
		}

		return null
	}, [props, layout])

	if (!props.keyExtractor) {
		throw new Error("VirtualList requires a keyExtractor prop")
	}

	if (props.grid && (typeof props.itemWidth !== "number" || typeof props.itemHeight !== "number")) {
		throw new Error("VirtualList in grid mode requires itemWidth and itemHeight props")
	}

	return (
		<View
			ref={viewRef}
			className={cn("flex-1 bg-transparent", props.parentClassName)}
			onLayout={onLayout}
		>
			{props.loading && (
				<AnimatedView
					className="absolute inset-0 z-99 bg-transparent items-center justify-center"
					exiting={FadeOut}
				>
					<ActivityIndicator
						size="large"
						color={textForeground.color as string}
					/>
				</AnimatedView>
			)}
			<FlashList<T>
				contentInsetAdjustmentBehavior="automatic"
				refreshing={refreshing}
				refreshControl={refreshControl}
				numColumns={itemsPerRow}
				drawDistance={Math.floor(Math.max(100, layout.height / 2, windowDimensions.height / 2))}
				maxItemsInRecyclePool={0}
				maintainVisibleContentPosition={{
					disabled: false,
					autoscrollToTopThreshold: undefined,
					autoscrollToBottomThreshold: undefined,
					animateAutoScrollToBottom: false,
					startRenderingFromBottom: false
				}}
				showsHorizontalScrollIndicator={!props.horizontal ? false : (props.data ?? []).length > 0 && !props.loading}
				showsVerticalScrollIndicator={props.horizontal ? false : (props.data ?? []).length > 0 && !props.loading}
				scrollEnabled={!props.loading && (props.data ?? []).length > 0}
				ListEmptyComponent={emptyComponent}
				ListFooterComponent={props.footerComponent}
				ListHeaderComponent={props.headerComponent}
				{...props}
			/>
		</View>
	)
}) as (<T>(props: FlashListProps<T> & React.RefAttributes<ListRef<T>> & VirtualListExtraProps) => React.JSX.Element) & {
	displayName?: string
}

export const VirtualList = withUniwind(VirtualListInner) as typeof VirtualListInner

export default VirtualList
