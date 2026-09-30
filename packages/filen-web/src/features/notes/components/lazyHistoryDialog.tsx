import { lazy } from "react"
import { loadHistoryDialog } from "@/features/notes/lib/historyDialogChunk"

export const HistoryDialog = lazy(async () => ({ default: (await loadHistoryDialog()).HistoryDialog }))
