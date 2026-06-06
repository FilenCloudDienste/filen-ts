import { NativeView } from "react-native-boost/runtime"
import { withUniwind } from "uniwind"
import { type ViewProps, type View as RNView, Platform, type StyleProp, type ViewStyle, StyleSheet } from "react-native"
import { cn } from "@filen/utils"
import {
	KeyboardAvoidingView as RNKeyboardControllerKeyboardAvoidingView,
	KeyboardAwareScrollView as RNKeyboardControllerKeyboardAwareScrollView,
	KeyboardStickyView as RNKeyboardControllerKeyboardStickyView
} from "react-native-keyboard-controller"
import { BlurView as ExpoBlurView } from "expo-blur"
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

export const UniwindBlurView = withUniwind(ExpoBlurView) as React.FC<React.ComponentProps<typeof ExpoBlurView>>

export const BlurView = (props: React.ComponentProps<typeof ExpoBlurView> & React.RefAttributes<RNView>) => {
	return <UniwindBlurView {...props} />
}

export const UniwindLiquidGlassView = withUniwind(ExpoGlassView) as React.FC<React.ComponentProps<typeof ExpoGlassView>>

export const LiquidGlassView = (props: React.ComponentProps<typeof ExpoGlassView> & React.RefAttributes<RNView>) => {
	return <UniwindLiquidGlassView {...props} />
}

export const UniwindGlassContainerView = withUniwind(ExpoGlassContainer) as React.FC<React.ComponentProps<typeof ExpoGlassContainer>>

export const LiquidGlassContainerView = (props: React.ComponentProps<typeof ExpoGlassContainer> & React.RefAttributes<RNView>) => {
	return <UniwindGlassContainerView {...props} />
}

const AndroidGlassContainer = ({
	children,
	className,
	style
}: {
	children: React.ReactNode
	className?: string
	style?: StyleProp<ViewStyle>
}) => {
	return (
		<View
			className={cn("border border-border rounded-full overflow-hidden bg-background-secondary/85", className)}
			style={[
				style,
				{
					borderWidth: StyleSheet.hairlineWidth,
					elevation: 4
				}
			]}
		>
			{children}
		</View>
	)
}

export const CrossGlassContainerView = ({
	children,
	className,
	style,
	disableLiquidGlass,
	disableBlur,
	disableInteraction
}: {
	children: React.ReactNode
	className?: string
	style?: StyleProp<ViewStyle>
	disableLiquidGlass?: boolean
	disableBlur?: boolean
	disableInteraction?: boolean
}) => {
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

	if (disableBlur) {
		return (
			<View
				className={cn("border border-border rounded-full overflow-hidden bg-background-secondary", className)}
				style={[
					style,
					{
						borderWidth: StyleSheet.hairlineWidth
					}
				]}
			>
				{children}
			</View>
		)
	}

	if (Platform.OS === "android") {
		return (
			<AndroidGlassContainer
				className={className}
				style={style}
			>
				{children}
			</AndroidGlassContainer>
		)
	}

	return (
		<BlurView
			className={cn("border border-border rounded-full overflow-hidden", className)}
			intensity={100}
			tint="systemChromeMaterial"
			style={[
				style,
				{
					borderWidth: StyleSheet.hairlineWidth
				}
			]}
		>
			{children}
		</BlurView>
	)
}

export const UniwindGestureHandlerScrollView = withUniwind(RNGestureHandlerScrollView) as React.FC<
	React.ComponentProps<typeof RNGestureHandlerScrollView>
>

export const GestureHandlerScrollView = (props: React.ComponentProps<typeof RNGestureHandlerScrollView> & React.RefAttributes<RNView>) => {
	return <UniwindGestureHandlerScrollView {...props} />
}

export default View
