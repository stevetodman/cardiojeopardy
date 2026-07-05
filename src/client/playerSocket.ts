import { io, type Socket } from 'socket.io-client'
import {
  CLIENT_TO_SERVER_EVENT,
  SERVER_TO_CLIENT_EVENT,
  type ClientHeartbeatIntent,
  type ClientToServerEventName,
  type ClientToServerPayloadMap,
  type DeadlineShape,
  type ErrorShape,
  type PlayerJoinIntent,
  type PlayerRejoinIntent,
  type ServerKickedPayload,
  type ServerPlayerTokenPayload,
  type ServerToClientEventName,
  type ServerToClientPayloadMap,
} from '../shared/protocol'

export interface PlayerSession {
  roomCode: string
  displayName: string
  playerToken?: string
  playerId?: string
  updatedAtMs: number
}

export const PLAYER_SESSION_STORAGE_KEY = 'cardiojeopardy.player.session.v1'

export interface PlayerSocketClient {
  connect: () => void
  disconnect: () => void
  close: () => void
  isConnected: () => boolean
  send: <TName extends ClientToServerEventName>(
    eventName: TName,
    payload: ClientToServerPayloadMap[TName],
  ) => void
  on(eventName: 'connect' | 'disconnect', handler: () => void): () => void
  on<TName extends ServerToClientEventName>(
    eventName: TName,
    handler: (payload: ServerToClientPayloadMap[TName]) => void,
  ): () => void
  on(eventName: string, handler: (payload: unknown) => void): () => void
}

type SocketLike = Pick<Socket, 'connect' | 'disconnect' | 'close' | 'connected' | 'on' | 'off' | 'emit'>

export function createPlayerSocket(socketUrl = window.location.origin): PlayerSocketClient {
  const socket = io(socketUrl, {
    autoConnect: false,
    transports: ['websocket', 'polling'],
    reconnection: true,
  }) as SocketLike

  return {
    connect() {
      socket.connect()
    },
    disconnect() {
      socket.disconnect()
    },
    close() {
      socket.close()
    },
    isConnected() {
      return socket.connected
    },
    send(eventName, payload) {
      socket.emit(eventName, payload)
    },
    on(eventName: string, handler: (payload: unknown) => void) {
      socket.on(eventName, handler as never)
      return () => {
        socket.off(eventName, handler as never)
      }
    },
  }
}

export function normalizeRoomCode(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8)
}

export function loadPlayerSession(): PlayerSession | null {
  const raw = safeStorageGet(PLAYER_SESSION_STORAGE_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<PlayerSession>
    if (!parsed.roomCode || !parsed.displayName || typeof parsed.updatedAtMs !== 'number') return null
    return {
      roomCode: normalizeRoomCode(parsed.roomCode),
      displayName: parsed.displayName.trim(),
      playerToken: typeof parsed.playerToken === 'string' && parsed.playerToken ? parsed.playerToken : undefined,
      playerId: typeof parsed.playerId === 'string' && parsed.playerId ? parsed.playerId : undefined,
      updatedAtMs: parsed.updatedAtMs,
    }
  } catch {
    return null
  }
}

export function savePlayerSession(session: PlayerSession): void {
  safeStorageSet(
    PLAYER_SESSION_STORAGE_KEY,
    JSON.stringify({
      ...session,
      roomCode: normalizeRoomCode(session.roomCode),
      displayName: session.displayName.trim(),
      updatedAtMs: Date.now(),
    }),
  )
}

export function clearPlayerSession(): void {
  safeStorageRemove(PLAYER_SESSION_STORAGE_KEY)
}

export function createJoinPayload(roomCode: string, displayName: string): PlayerJoinIntent {
  return {
    roomCode: normalizeRoomCode(roomCode),
    displayName: displayName.trim(),
  }
}

export function createRejoinPayload(roomCode: string, displayName: string, playerToken: string): PlayerRejoinIntent {
  return {
    roomCode: normalizeRoomCode(roomCode),
    displayName: displayName.trim(),
    playerToken,
  }
}

export function createHeartbeatPayload(
  roomCode: string | undefined,
  playerId: string | undefined,
  token: string | undefined,
): ClientHeartbeatIntent {
  return {
    sentAtMs: Date.now(),
    roomCode: roomCode ? normalizeRoomCode(roomCode) : undefined,
    playerId,
    token,
  }
}

export function isPlayerTokenPayload(payload: unknown): payload is ServerPlayerTokenPayload {
  return Boolean(payload && typeof payload === 'object' && typeof (payload as ServerPlayerTokenPayload).playerToken === 'string')
}

export function isDeadlinePayload(payload: unknown): payload is DeadlineShape {
  return Boolean(
    payload &&
      typeof payload === 'object' &&
      typeof (payload as DeadlineShape).deadlineId === 'string' &&
      typeof (payload as DeadlineShape).eventName === 'string',
  )
}

export function isErrorPayload(payload: unknown): payload is ErrorShape {
  return Boolean(payload && typeof payload === 'object' && typeof (payload as ErrorShape).code === 'string')
}

export function isKickedPayload(payload: unknown): payload is ServerKickedPayload {
  return Boolean(payload && typeof payload === 'object' && typeof (payload as ServerKickedPayload).roomCode === 'string')
}

export function isClientConnected(socket: PlayerSocketClient | null): boolean {
  return socket?.isConnected() ?? false
}

function safeStorageGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeStorageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Ignore storage errors in private mode or on failed quota.
  }
}

function safeStorageRemove(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // Ignore storage errors in private mode or on failed quota.
  }
}

export { CLIENT_TO_SERVER_EVENT, SERVER_TO_CLIENT_EVENT }
