import { createContext } from "react"

// Moves the thread to a message by uuid, paging older history in toward it when it is not loaded yet
// (messageThread.tsx). A stable function, so a reply quote reading it never re-renders with the thread.
export const ThreadJumpContext = createContext<((uuid: string) => void) | null>(null)
