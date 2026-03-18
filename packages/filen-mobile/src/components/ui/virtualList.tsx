import { useRef, useState, Fragment } from "react"
import { withUniwind, useResolveClassNames } from "uniwind"
import { type View as RNView, RefreshControl, ActivityIndicator, useWindowDimensions, TextInput, Platform } from "react-native"
import View, { CrossGlassContainerView, KeyboardAvoidingView } from "@/components/ui/view"
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
import { useHeaderHeight } from "@react-navigation/elements"
import { PressableScale } from "@/components/ui/pressables"
import Ionicons from "@expo/vector-icons/Ionicons"
import { KeyboardController } from "react-native-keyboard-controller"

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
	keyboardAvoidingViewBehavior?: React.ComponentProps<typeof KeyboardAvoidingView>["behavior"]
	searchBar?: {
		onChangeText?: (text: string) => void
		placeholder?: string
	}
}

const ListSearchBar = memo(
	({
		onChangeText,
		onHeightChange,
		placeholder
	}: {
		onChangeText?: (text: string) => void
		onHeightChange?: (height: number) => void
		placeholder?: string
	}) => {
		const headerHeight = useHeaderHeight()
		const textForeground = useResolveClassNames("text-foreground")
		const [hasText, setHasText] = useState<boolean>(false)
		const inputRef = useRef<TextInput>(null)

		const onChangeTextInternal = useCallback(
			(text: string) => {
				setHasText(text.length > 0)
				onChangeText?.(text)
			},
			[onChangeText]
		)

		const clear = useCallback(() => {
			inputRef?.current?.clear()

			setHasText(false)
			onChangeText?.("")

			if (KeyboardController.isVisible()) {
				KeyboardController.dismiss().catch(err => {
					console.error(err)
					alerts.error(err)
				})
			}
		}, [onChangeText])

		return (
			<View
				onLayout={e => onHeightChange?.(e.nativeEvent.layout.height)}
				className="bg-transparent"
				style={{
					top: Platform.select({
						ios: headerHeight,
						default: 0
					}),
					position: "absolute",
					left: 0,
					right: 0,
					zIndex: 100,
					paddingTop: Platform.select({
						ios: 0,
						android: 8
					})
				}}
			>
				<View className="px-4 pb-4 shrink-0 bg-transparent">
					<CrossGlassContainerView className="flex-row items-center gap-2 px-3 w-full h-full">
						<View className="bg-transparent flex-row items-center justify-center">
							<Ionicons
								name="search"
								size={20}
								color={textForeground.color}
							/>
						</View>
						<TextInput
							ref={inputRef}
							className="py-3 text-foreground flex-1 h-11"
							placeholder={placeholder ?? "tbd_search"}
							placeholderTextColorClassName="text-muted-foreground"
							onChangeText={onChangeTextInternal}
							autoCapitalize="none"
							autoCorrect={false}
							spellCheck={false}
							returnKeyType="search"
							autoComplete="off"
							autoFocus={false}
						/>
						{hasText && (
							<PressableScale
								className="bg-transparent flex-row items-center justify-center"
								onPress={clear}
								hitSlop={10}
							>
								<Ionicons
									name="close"
									size={20}
									color={textForeground.color}
								/>
							</PressableScale>
						)}
					</CrossGlassContainerView>
				</View>
			</View>
		)
	}
)

const VirtualListInner = memo(<T,>(props: FlashListProps<T> & React.RefAttributes<ListRef<T>> & VirtualListExtraProps) => {
	const viewRef = useRef<RNView>(null)
	const { layout, onLayout } = useViewLayout(viewRef)
	const [refreshing, setRefreshing] = useState<boolean>(false)
	const textForeground = useResolveClassNames("text-foreground")
	const windowDimensions = useWindowDimensions()
	const [searchBarHeight, setSearchBarHeight] = useState<number>(0)

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
				progressViewOffset={props.searchBar ? searchBarHeight : undefined}
			/>
		)
	}, [props, refreshing, onRefresh, searchBarHeight])

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
		<Fragment>
			{props.searchBar && (
				<ListSearchBar
					onChangeText={props.searchBar.onChangeText}
					onHeightChange={setSearchBarHeight}
					placeholder={props.searchBar.placeholder}
				/>
			)}
			<View
				ref={viewRef}
				className={cn("flex-1 bg-transparent", props.parentClassName)}
				onLayout={onLayout}
			>
				<KeyboardAvoidingView
					className={cn("flex-1 bg-transparent", props.parentClassName)}
					behavior={props.keyboardAvoidingViewBehavior ?? "padding"}
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
						contentContainerStyle={[
							props.contentContainerStyle,
							{
								paddingTop: props.searchBar ? searchBarHeight : 0
							}
						]}
					/>
				</KeyboardAvoidingView>
			</View>
		</Fragment>
	)
}) as (<T>(props: FlashListProps<T> & React.RefAttributes<ListRef<T>> & VirtualListExtraProps) => React.JSX.Element) & {
	displayName?: string
}

const VirtualList = withUniwind(VirtualListInner) as typeof VirtualListInner

export default VirtualList
