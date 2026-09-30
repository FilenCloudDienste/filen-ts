import { Platform } from "react-native"
import { cn } from "@filen/shared"

// Scroll content of the single-item detail screens (item info, linked file, directory color).
export const ITEM_DETAIL_CONTENT_CLASS = cn("bg-transparent px-4 flex-col pb-40 pt-10", Platform.OS === "ios" && "pt-24")
