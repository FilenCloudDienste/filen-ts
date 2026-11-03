import type { PresentationGroups } from "@/features/presentation/components/ribbon/tabs"
import { mediaTimingGroups } from "@/features/presentation/components/ribbon/mediaTiming"
import { mediaPlaybackGroups } from "@/features/presentation/components/ribbon/video"

// The Audio tab: the selected audio clip's playback in the show (the Video tab's Playback group, without full screen).
export const audioGroups: PresentationGroups = context => [...mediaPlaybackGroups("audio", context), ...mediaTimingGroups("audio", context)]
