import { NativeView } from "react-native-boost/runtime"
import { withUniwind, useUniwind } from "uniwind"
import { type ViewProps, type View as RNView, Platform, type StyleProp, type ViewStyle, StyleSheet } from "react-native"
import { cn } from "@filen/utils"
import {
	KeyboardAvoidingView as RNKeyboardControllerKeyboardAvoidingView,
	KeyboardAwareScrollView as RNKeyboardControllerKeyboardAwareScrollView,
	KeyboardStickyView as RNKeyboardControllerKeyboardStickyView
} from "react-native-keyboard-controller"
import { GlassView as ExpoGlassView, GlassContainer as ExpoGlassContainer } from "expo-glass-effect"
import { ScrollView as RNGestureHandlerScrollView } from "react-native-gesture-handler"

export const UniwindView = withUniwind(NativeView) as React.FC<ViewProps>

export const View = ((props: React.ComponentPropsWithRef<typeof RNView>) => {
	return (
		<UniwindView
			{...props}
			className={cn("bg-background", props.className)}
		/>
	)
}) as unknown as React.FC<React.ComponentPropsWithRef<typeof RNView>>

export const UniwindKeyboardAvoidingView = withUniwind(RNKeyboardControllerKeyboardAvoidingView) as React.FC<
	React.ComponentProps<typeof RNKeyboardControllerKeyboardAvoidingView>
>

export const KeyboardAvoidingView = (
	props: React.ComponentProps<typeof RNKeyboardControllerKeyboardAvoidingView> & React.RefAttributes<RNView>
) => {
	return (
		<UniwindKeyboardAvoidingView
			{...props}
			className={cn("bg-background", props.className)}
		/>
	)
}

export const UniwindKeyboardAwareScrollView = withUniwind(RNKeyboardControllerKeyboardAwareScrollView) as React.FC<
	React.ComponentProps<typeof RNKeyboardControllerKeyboardAwareScrollView>
>

export const KeyboardAwareScrollView = (
	props: React.ComponentProps<typeof RNKeyboardControllerKeyboardAwareScrollView> & React.RefAttributes<RNView>
) => {
	return (
		<UniwindKeyboardAwareScrollView
			{...props}
			className={cn("bg-background", props.className)}
		/>
	)
}

export const UniwindKeyboardStickyView = withUniwind(RNKeyboardControllerKeyboardStickyView) as React.FC<
	React.ComponentProps<typeof RNKeyboardControllerKeyboardStickyView>
>

export const KeyboardStickyView = (
	props: React.ComponentProps<typeof RNKeyboardControllerKeyboardStickyView> & React.RefAttributes<RNView>
) => {
	return (
		<UniwindKeyboardStickyView
			{...props}
			className={cn("bg-background", props.className)}
		/>
	)
}

export const UniwindLiquidGlassView = withUniwind(ExpoGlassView) as React.FC<React.ComponentProps<typeof ExpoGlassView>>

export const LiquidGlassView = (props: React.ComponentProps<typeof ExpoGlassView> & React.RefAttributes<RNView>) => {
	return <UniwindLiquidGlassView {...props} />
}

export const UniwindGlassContainerView = withUniwind(ExpoGlassContainer) as React.FC<React.ComponentProps<typeof ExpoGlassContainer>>

export const LiquidGlassContainerView = (props: React.ComponentProps<typeof ExpoGlassContainer> & React.RefAttributes<RNView>) => {
	return <UniwindGlassContainerView {...props} />
}

// Single-View "liquid glass" approximation for everywhere the real material is unavailable
// (Android, and iOS with disableLiquidGlass). No blur: expo-blur on Android needs the BlurView
// to live OUTSIDE its BlurTargetView — a descendant creates a circular RenderNode reference and
// crashes libhwui with a native stack overflow — which our in-screen glass surfaces can't
// satisfy, so the material is faked with layered box shadows instead:
// outer = soft lift, inset top = specular rim catching light, inset bottom = depth shading.
// Theme-split because the dark stack reads as dirty smudges on light surfaces — light mode
// needs a much subtler lift/shade and a stronger white rim to register against #f2f2f7.
const FAKE_GLASS_BOX_SHADOW_DARK: ViewStyle["boxShadow"] = [
	{
		offsetX: 0,
		offsetY: 6,
		blurRadius: 18,
		color: "rgba(0, 0, 0, 0.28)"
	},
	{
		offsetX: 0,
		offsetY: 1,
		blurRadius: 1,
		color: "rgba(255, 255, 255, 0.20)",
		inset: true
	},
	{
		offsetX: 0,
		offsetY: -1,
		blurRadius: 1,
		color: "rgba(0, 0, 0, 0.18)",
		inset: true
	}
]

const FAKE_GLASS_BOX_SHADOW_LIGHT: ViewStyle["boxShadow"] = [
	{
		offsetX: 0,
		offsetY: 4,
		blurRadius: 14,
		color: "rgba(0, 0, 0, 0.12)"
	},
	{
		offsetX: 0,
		offsetY: 1,
		blurRadius: 1,
		color: "rgba(255, 255, 255, 0.75)",
		inset: true
	},
	{
		offsetX: 0,
		offsetY: -1,
		blurRadius: 1,
		color: "rgba(0, 0, 0, 0.06)",
		inset: true
	}
]

export const CrossGlassContainerView = ({
	children,
	className,
	style,
	disableLiquidGlass,
	disableInteraction
}: {
	children: React.ReactNode
	className?: string
	style?: StyleProp<ViewStyle>
	disableLiquidGlass?: boolean
	disableInteraction?: boolean
}) => {
	const { theme } = useUniwind()

	if (Platform.OS === "ios" && !disableLiquidGlass) {
		return (
			<LiquidGlassView
				className={cn("rounded-full overflow-hidden", className)}
				isInteractive={!disableInteraction}
				style={style}
			>
				{children}
			</LiquidGlassView>
		)
	}

	return (
		<View
			className={cn("rounded-full overflow-hidden border bg-background-secondary/95 border-black/10 dark:border-white/15", className)}
			style={[
				style,
				{
					borderWidth: StyleSheet.hairlineWidth,
					boxShadow: theme === "dark" ? FAKE_GLASS_BOX_SHADOW_DARK : FAKE_GLASS_BOX_SHADOW_LIGHT
				}
			]}
		>
			{children}
		</View>
	)
}

export const UniwindGestureHandlerScrollView = withUniwind(RNGestureHandlerScrollView) as React.FC<
	React.ComponentProps<typeof RNGestureHandlerScrollView>
>

export const GestureHandlerScrollView = (props: React.ComponentProps<typeof RNGestureHandlerScrollView> & React.RefAttributes<RNView>) => {
	return <UniwindGestureHandlerScrollView {...props} />
}

export default View
