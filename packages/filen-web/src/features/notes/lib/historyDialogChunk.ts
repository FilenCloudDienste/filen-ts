// The history dialog's chunk, kept out of the shell chunk for its CodeMirror/markdown readers. AppShell
// warms it after mount, so the dialog still opens offline.
export const loadHistoryDialog = () => import("@/features/notes/components/historyDialog")
