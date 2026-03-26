import { ImageBackground as ExpoImageBackground, Image as ExpoImageNative } from "expo-image"
import { withUniwind } from "uniwind"
import { memo } from "react"
import { cn } from "@filen/utils"

const UniwindImage = memo(withUniwind(ExpoImageNative) as React.FC<React.ComponentProps<typeof ExpoImageNative>>)

export const Image = memo((props: React.ComponentProps<typeof ExpoImageNative> & React.RefAttributes<typeof ExpoImageNative>) => {
	return (
		<UniwindImage
			{...props}
			style={props.style}
			className={cn("bg-background", props.className)}
		/>
	)
})

const UniwindImageBackground = memo(withUniwind(ExpoImageBackground) as React.FC<React.ComponentProps<typeof ExpoImageBackground>>)

export const ImageBackground = memo(
	(props: React.ComponentProps<typeof ExpoImageBackground> & React.RefAttributes<typeof ExpoImageBackground>) => {
		return (
			<UniwindImageBackground
				{...props}
				className={cn("bg-background", props.className)}
			/>
		)
	}
)

const UniwindExpoImage = memo(withUniwind(ExpoImageNative) as React.FC<React.ComponentProps<typeof ExpoImageNative>>)

export const ExpoImage = memo((props: React.ComponentProps<typeof ExpoImageNative> & React.RefAttributes<typeof ExpoImageNative>) => {
	return (
		<UniwindExpoImage
			{...props}
			className={cn("bg-background", props.className)}
		/>
	)
})

export default Image
