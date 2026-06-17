import { useRef, useState, Fragment } from "react"
import { withUniwind, useResolveClassNames } from "uniwind"
import { type View as RNView, RefreshControl, ActivityIndicator } from "react-native"
import View from "@/components/ui/view"
import useViewLayout from "@/hooks/useViewLayout"
import { cn, run, type DeferFn } from "@filen/utils"
import alerts from "@/lib/alerts"
import { AnimatedView } from "@/components/ui/animated"
import { FadeOut } from "react-native-reanimated"
import {
	FlashList,
	type FlashListProps,
	type FlashListRef,
	type ListRenderItemInfo as FlashListListRenderItemInfo
} from "@shopify/flash-list"
import logger from "@/lib/logger"

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

/**
 * Pure helper that resolves the number of columns for a VirtualList.
 * Exported for unit-testing only.
 *
 * Rules (in priority order):
 *  1. If an explicit `itemsPerRow` prop is provided (truthy), use it.
 *  2. If grid mode is off OR itemWidth is absent, return 1.
 *  3. Otherwise compute Math.round(Math.max(1, Math.round(layoutWidth / itemWidth))).
 *     The inner Math.max(1, …) clamps to ≥1, protecting against layoutWidth=0.
 */
export function resolveItemsPerRow({
	itemsPerRow,
	grid,
	itemWidth,
	layoutWidth
}: {
	itemsPerRow?: number
	grid?: boolean
	itemWidth?: number
	layoutWidth: number
}): number {
	if (itemsPerRow) {
		return itemsPerRow
	}

	if (!grid || !itemWidth) {
		return 1
	}

	return Math.round(Math.max(1, Math.round(layoutWidth / itemWidth)))
}

/**
 * Validates required VirtualList props; throws with a descriptive message
 * when a required constraint is violated.
 * Exported for unit-testing only.
 */
export function validateVirtualListProps({
	keyExtractor,
	grid,
	itemWidth,
	itemHeight
}: {
	keyExtractor?: unknown
	grid?: boolean
	itemWidth?: number
	itemHeight?: number
}): void {
	if (!keyExtractor) {
		throw new Error("VirtualList requires a keyExtractor prop")
	}

	if (grid && (typeof itemWidth !== "number" || typeof itemHeight !== "number")) {
		throw new Error("VirtualList in grid mode requires itemWidth and itemHeight props")
	}
}

const VirtualListInner = (<T,>(props: FlashListProps<T> & React.RefAttributes<ListRef<T>> & VirtualListExtraProps) => {
	const viewRef = useRef<RNView>(null)
	const { layout, onLayout } = useViewLayout(viewRef)
	const [refreshing, setRefreshing] = useState<boolean>(false)
	const textForeground = useResolveClassNames("text-foreground")

	const itemsPerRow = resolveItemsPerRow({
		itemsPerRow: props.itemsPerRow,
		grid: props.grid,
		itemWidth: props.itemWidth,
		layoutWidth: layout.width
	})

	const onRefresh = async () => {
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
			logger.error("ui", "VirtualList pull-to-refresh failed", { error: result.error })
			alerts.error(result.error)
		}
	}

	const refreshControl = (() => {
		if (!props.onRefresh) {
			return undefined
		}

		return (
			<RefreshControl
				refreshing={refreshing}
				onRefresh={onRefresh}
			/>
		)
	})()

	const emptyComponent = (() => {
		if (props.loading) {
			return null
		}

		if (props.emptyComponent) {
			return <View className="flex-1 bg-transparent">{props.emptyComponent()}</View>
		}

		return null
	})()

	// When the list is empty, stretch the scroll content to fill the viewport so the
	// emptyComponent's `flex-1` actually centers it. Without `flexGrow: 1` the content
	// collapses to its intrinsic height and `contentInsetAdjustmentBehavior="automatic"`
	// pushes it below the visual centre + makes the (otherwise empty) list scrollable.
	// Populated lists keep the caller's contentContainerStyle untouched.
	const isEmpty = !props.loading && (props.data?.length ?? 0) === 0

	validateVirtualListProps({
		keyExtractor: props.keyExtractor,
		grid: props.grid,
		itemWidth: props.itemWidth,
		itemHeight: props.itemHeight
	})

	return (
		<Fragment>
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
					numColumns={itemsPerRow}
					drawDistance={0}
					maintainVisibleContentPosition={{
						disabled: true
					}}
					showsHorizontalScrollIndicator={!props.horizontal ? false : (props.data ?? []).length > 0 && !props.loading}
					showsVerticalScrollIndicator={props.horizontal ? false : (props.data ?? []).length > 0 && !props.loading}
					scrollEnabled={!props.loading && !isEmpty && ((props.data ?? []).length > 0 || Boolean(props.onRefresh))}
					ListEmptyComponent={emptyComponent}
					ListFooterComponent={props.footerComponent}
					ListHeaderComponent={props.headerComponent}
					{...props}
					contentContainerStyle={isEmpty ? [{ flexGrow: 1 }, props.contentContainerStyle] : props.contentContainerStyle}
					refreshing={refreshing}
					refreshControl={refreshControl}
				/>
			</View>
		</Fragment>
	)
}) as (<T>(props: FlashListProps<T> & React.RefAttributes<ListRef<T>> & VirtualListExtraProps) => React.JSX.Element) & {
	displayName?: string
}

const VirtualList = withUniwind(VirtualListInner) as typeof VirtualListInner as (<T>(
	props: FlashListProps<T> & React.RefAttributes<ListRef<T>> & VirtualListExtraProps
) => React.JSX.Element) & {
	displayName?: string
}

export default VirtualList
