// Mutable cross-module singletons. Exported as `let` bindings so consumers can
// read the current value with the original identifier (ESM live bindings),
// while writes go through setter functions to stay disciplined.

export let MY_PORT = 0
export let lastChatId: number | null = null
export let lastUserId: number | null = null

export function setMyPort(port: number): void {
  MY_PORT = port
}

export function setLastSession(chatId: number, userId: number): void {
  lastChatId = chatId
  lastUserId = userId
}
