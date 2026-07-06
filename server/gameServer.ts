import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import process from 'node:process'
import { readFile, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { Server as SocketIOServer, type Socket } from 'socket.io'
import { createServer as createViteServer, type ViteDevServer } from 'vite'
import {
  CLIENT_TO_SERVER_EVENT,
  SERVER_TO_CLIENT_EVENT,
  type AckShape,
  type DeadlineShape,
  type ErrorShape,
  type ServerRoomCreatedPayload,
  type RoomSnapshotShape,
} from '../src/shared/protocol'
import {
  advanceRuntime,
  createRuntime,
  createSnapshot,
  createEngineError,
  getDeadline,
  heartbeat,
  hostFinalOverride,
  joinPlayer,
  kickPlayer,
  pauseRoom,
  rejoinPlayer,
  resetRoom,
  selectClue,
  submitAnswerChoice,
  submitBuzz,
  submitFinalAnswer,
  submitWager,
  continueRoom,
  type EngineRuntime,
  type PlayerSession,
} from '../src/engine/quizEngine'
import { loadQuizBoardContent } from './contentLoader'

export interface StartGameServerOptions {
  port?: number
  host?: string
  dev?: boolean
  staticDir?: string
  logger?: Pick<Console, 'log' | 'warn' | 'error'>
}

export interface GameServerHandle {
  httpServer: HttpServer
  io: SocketIOServer
  vite?: ViteDevServer
  rooms: Map<string, RoomSession>
  baseUrl: string
  close: () => Promise<void>
}

interface RoomSession {
  runtime: EngineRuntime
  hostSocketId: string
  socketToRoomCode: Map<string, string>
  socketToPlayerId: Map<string, string>
  playerIdToSocketId: Map<string, string>
  joinUrl: string
  hostJoinUrl: string
  playerJoinUrl: string
  lastBroadcastAtMs: number
}

const INTERNAL_EVENTS = new Set(['connect', 'disconnect', 'error', 'connect_error', 'newListener', 'removeListener'])

export async function startGameServer(options: StartGameServerOptions = {}): Promise<GameServerHandle> {
  const logger = options.logger ?? console
  const port = options.port ?? Number(process.env.PORT ?? 5173)
  const host = options.host ?? '0.0.0.0'
  const content = loadQuizBoardContent()
  const rooms = new Map<string, RoomSession>()
  let baseUrl = ''
  const tickIntervalMs = 250
  const staticDir = resolve(options.staticDir ?? 'dist')

  const vite = options.dev === false ? undefined : await createViteServer({
    appType: 'custom',
    server: {
      middlewareMode: true,
      allowedHosts: true,
    },
  })

  const httpServer = createServer((req, res) => {
    if (serveDiagnostics(req, res, () => baseUrl)) {
      return
    }
    if (vite) {
      void vite.middlewares(req, res, () => {
        void serveViteIndex(vite, req, res).catch((error: unknown) => {
          vite.ssrFixStacktrace(error as Error)
          res.statusCode = 500
          res.end(error instanceof Error ? error.message : 'Failed to serve app shell')
        })
      })
      return
    }
    void serveProductionApp(req, res, staticDir).catch((error: unknown) => {
      logger.error('[quiz-board] failed to serve production app', error)
      res.statusCode = 500
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.end('Failed to serve app shell')
    })
  })

  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: true,
      credentials: true,
    },
  })

  registerSocketHandlers(io, rooms, content, logger, () => baseUrl)

  const tickHandle = setInterval(() => {
    const nowMs = Date.now()
    for (const session of rooms.values()) {
      broadcastSnapshot(io, session, nowMs)
    }
  }, tickIntervalMs)

  const actualPort = await listenOnAvailablePort(httpServer, port, host, logger)
  baseUrl = getPublishedBaseUrl(actualPort)
  logger.log(`[quiz-board] listening on ${baseUrl}`)

  return {
    httpServer,
    io,
    vite,
    rooms,
    baseUrl,
    close: async () => {
      clearInterval(tickHandle)
      await io.close()
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
      if (vite) {
        await vite.close()
      }
    },
  }
}

function registerSocketHandlers(
  io: SocketIOServer,
  rooms: Map<string, RoomSession>,
  content: ReturnType<typeof loadQuizBoardContent>,
  logger: Pick<Console, 'log' | 'warn' | 'error'>,
  getBaseUrl: () => string,
): void {
  io.on('connection', (socket) => {
    socket.onAny((eventName: string) => {
      if (INTERNAL_EVENTS.has(eventName) || isAllowedClientEvent(eventName)) return
      if (isForbiddenClientEvent(eventName)) {
        emitError(socket, {
          code: 'forbidden_event',
          message: `Event ${eventName} is blocked by the server.`,
          retryable: false,
          details: { eventName },
        })
        return
      }
      emitError(socket, {
        code: 'unknown_event',
        message: `Unknown event ${eventName}.`,
        retryable: false,
        details: { eventName },
      })
    })

    socket.on(CLIENT_TO_SERVER_EVENT.HOST_CREATE_ROOM, (payload) => {
      const nowMs = Date.now()
      const roomCode = generateRoomCode(rooms)
      const runtime = createRuntime({
        roomCode,
        roomName: sanitizeText((payload as { roomName?: string }).roomName),
        hostName: sanitizeText((payload as { hostName?: string }).hostName),
        content,
        nowMs,
      })
      const session = createRoomSession(runtime, socket.id, buildRoomUrls(getPublicBaseUrl(socket, getBaseUrl()), roomCode))
      rooms.set(roomCode, session)
      socket.data.roomCode = roomCode
      socket.data.isHost = true
      socket.join(roomCode)
      emitPlayerToken(socket, runtime.hostToken, runtime.room.hostPlayerId)
      emitAck(socket, CLIENT_TO_SERVER_EVENT.HOST_CREATE_ROOM, nowMs)
      emitRoomCreated(io, session, nowMs)
      broadcastSnapshot(io, session, nowMs)
    })

    socket.on(CLIENT_TO_SERVER_EVENT.HOST_PAUSE, () => {
      const session = requireHostSession(socket, rooms)
      const nowMs = Date.now()
      session.runtime = pauseRoom(session.runtime, nowMs)
      session.lastBroadcastAtMs = 0
      emitAck(socket, CLIENT_TO_SERVER_EVENT.HOST_PAUSE, nowMs)
      broadcastSnapshot(io, session, nowMs)
    })

    socket.on(CLIENT_TO_SERVER_EVENT.HOST_RESUME, () => {
      const session = requireHostSession(socket, rooms)
      const nowMs = Date.now()
      session.runtime = continueRoom(session.runtime, nowMs)
      session.runtime = advanceRuntime(session.runtime, nowMs)
      emitAck(socket, CLIENT_TO_SERVER_EVENT.HOST_RESUME, nowMs)
      broadcastSnapshot(io, session, nowMs)
    })

    socket.on(CLIENT_TO_SERVER_EVENT.HOST_RESET_ROOM, (payload) => {
      const session = requireHostSession(socket, rooms)
      const nowMs = Date.now()
      session.runtime = resetRoom(session.runtime, nowMs, Boolean((payload as { hardReset?: boolean }).hardReset))
      emitAck(socket, CLIENT_TO_SERVER_EVENT.HOST_RESET_ROOM, nowMs)
      broadcastSnapshot(io, session, nowMs)
    })

    socket.on(CLIENT_TO_SERVER_EVENT.HOST_KICK_PLAYER, (payload) => {
      const session = requireHostSession(socket, rooms)
      const playerId = sanitizeText((payload as { playerId?: string }).playerId)
      const nowMs = Date.now()
      session.runtime = kickPlayer(session.runtime, playerId, nowMs)
      const kickedSocketId = session.playerIdToSocketId.get(playerId)
      if (kickedSocketId) {
        const kickedSocket = io.sockets.sockets.get(kickedSocketId)
        kickedSocket?.emit(SERVER_TO_CLIENT_EVENT.KICKED, {
          playerId,
          roomCode: session.runtime.room.code,
          reason: 'Removed by host.',
        })
        kickedSocket?.disconnect(true)
        session.playerIdToSocketId.delete(playerId)
        session.socketToPlayerId.delete(kickedSocketId)
        session.socketToRoomCode.delete(kickedSocketId)
      }
      emitAck(socket, CLIENT_TO_SERVER_EVENT.HOST_KICK_PLAYER, nowMs)
      broadcastSnapshot(io, session, nowMs)
    })

    socket.on(CLIENT_TO_SERVER_EVENT.HOST_FINAL_OVERRIDE, (payload) => {
      const session = requireHostSession(socket, rooms)
      const nowMs = Date.now()
      session.runtime = hostFinalOverride(session.runtime, payload as { teamId?: string; wager?: number; answerId?: string; correct?: boolean }, nowMs)
      session.runtime = advanceRuntime(session.runtime, nowMs)
      emitAck(socket, CLIENT_TO_SERVER_EVENT.HOST_FINAL_OVERRIDE, nowMs)
      broadcastSnapshot(io, session, nowMs)
    })

    socket.on(CLIENT_TO_SERVER_EVENT.PLAYER_JOIN, (payload) => {
      const nowMs = Date.now()
      const roomCode = sanitizeRoomCode((payload as { roomCode?: string }).roomCode)
      const session = requireRoomSession(roomCode, rooms)
      const { runtime, player, session: tokenSession } = joinPlayer(
        session.runtime,
        sanitizeText((payload as { displayName?: string }).displayName),
        sanitizeText((payload as { teamId?: string }).teamId),
        nowMs,
      )
      session.runtime = advanceRuntime(runtime, nowMs)
      const resolvedPlayer = player ?? session.runtime.playersById.get(tokenSession?.playerId ?? '')
      if (!resolvedPlayer) {
        throw createEngineError('player_not_found', 'The player could not be created.', false)
      }
      bindPlayerSession(session, socket, tokenSession ?? { playerId: resolvedPlayer.id, playerToken: resolvedPlayer.token })
      socket.join(roomCode)
      emitPlayerToken(socket, resolvedPlayer.token, resolvedPlayer.id)
      emitAck(socket, CLIENT_TO_SERVER_EVENT.PLAYER_JOIN, nowMs)
      broadcastSnapshot(io, session, nowMs)
    })

    socket.on(CLIENT_TO_SERVER_EVENT.PLAYER_REJOIN, (payload) => {
      const nowMs = Date.now()
      const roomCode = sanitizeRoomCode((payload as { roomCode?: string }).roomCode)
      const session = requireRoomSession(roomCode, rooms)
      const token = sanitizeText((payload as { playerToken?: string }).playerToken)
      const { runtime, player, session: tokenSession } = rejoinPlayer(
        session.runtime,
        sanitizeText((payload as { displayName?: string }).displayName),
        token,
        nowMs,
      )
      session.runtime = advanceRuntime(runtime, nowMs)
      const resolvedPlayer = player ?? session.runtime.playersById.get(tokenSession?.playerId ?? '')
      if (!resolvedPlayer) {
        throw createEngineError('player_not_found', 'The player could not be restored.', false)
      }
      bindPlayerSession(session, socket, tokenSession ?? { playerId: resolvedPlayer.id, playerToken: token })
      socket.join(roomCode)
      emitPlayerToken(socket, token, resolvedPlayer.id)
      emitAck(socket, CLIENT_TO_SERVER_EVENT.PLAYER_REJOIN, nowMs)
      broadcastSnapshot(io, session, nowMs)
    })

    socket.on(CLIENT_TO_SERVER_EVENT.PLAYER_SELECT_CLUE, (payload) => {
      const nowMs = Date.now()
      const session = requirePlayerSession(socket, rooms)
      const playerId = requirePlayerId(socket)
      session.runtime = selectClue(session.runtime, playerId, sanitizeText((payload as { clueId?: string }).clueId), nowMs)
      session.runtime = advanceRuntime(session.runtime, nowMs)
      emitAck(socket, CLIENT_TO_SERVER_EVENT.PLAYER_SELECT_CLUE, nowMs)
      broadcastSnapshot(io, session, nowMs)
    })

    socket.on(CLIENT_TO_SERVER_EVENT.PLAYER_BUZZ, (payload) => {
      const nowMs = Date.now()
      const session = requirePlayerSession(socket, rooms)
      const playerId = requirePlayerId(socket)
      session.runtime = submitBuzz(session.runtime, playerId, sanitizeText((payload as { clueId?: string }).clueId), nowMs)
      session.runtime = advanceRuntime(session.runtime, nowMs)
      emitAck(socket, CLIENT_TO_SERVER_EVENT.PLAYER_BUZZ, nowMs)
      broadcastSnapshot(io, session, nowMs)
    })

    socket.on(CLIENT_TO_SERVER_EVENT.PLAYER_ANSWER_CHOICE, (payload) => {
      const nowMs = Date.now()
      const session = requirePlayerSession(socket, rooms)
      const playerId = requirePlayerId(socket)
      session.runtime = submitAnswerChoice(
        session.runtime,
        playerId,
        sanitizeText((payload as { clueId?: string }).clueId),
        sanitizeText((payload as { choiceId?: string }).choiceId),
        nowMs,
      )
      session.runtime = advanceRuntime(session.runtime, nowMs)
      emitAck(socket, CLIENT_TO_SERVER_EVENT.PLAYER_ANSWER_CHOICE, nowMs)
      broadcastSnapshot(io, session, nowMs)
    })

    socket.on(CLIENT_TO_SERVER_EVENT.PLAYER_SUBMIT_WAGER, (payload) => {
      const nowMs = Date.now()
      const session = requirePlayerSession(socket, rooms)
      const playerId = requirePlayerId(socket)
      session.runtime = submitWager(session.runtime, playerId, Number((payload as { wager?: number }).wager ?? 0), nowMs)
      session.runtime = advanceRuntime(session.runtime, nowMs)
      emitAck(socket, CLIENT_TO_SERVER_EVENT.PLAYER_SUBMIT_WAGER, nowMs)
      broadcastSnapshot(io, session, nowMs)
    })

    socket.on(CLIENT_TO_SERVER_EVENT.PLAYER_SUBMIT_FINAL_ANSWER, (payload) => {
      const nowMs = Date.now()
      const session = requirePlayerSession(socket, rooms)
      const playerId = requirePlayerId(socket)
      session.runtime = submitFinalAnswer(session.runtime, playerId, sanitizeText((payload as { choiceId?: string }).choiceId), nowMs)
      session.runtime = advanceRuntime(session.runtime, nowMs)
      emitAck(socket, CLIENT_TO_SERVER_EVENT.PLAYER_SUBMIT_FINAL_ANSWER, nowMs)
      broadcastSnapshot(io, session, nowMs)
    })

    socket.on(CLIENT_TO_SERVER_EVENT.PLAYER_CONTINUE, () => {
      const nowMs = Date.now()
      const session = requirePlayerSession(socket, rooms)
      session.runtime = continueRoom(session.runtime, nowMs)
      session.runtime = advanceRuntime(session.runtime, nowMs)
      emitAck(socket, CLIENT_TO_SERVER_EVENT.PLAYER_CONTINUE, nowMs)
      broadcastSnapshot(io, session, nowMs)
    })

    socket.on(CLIENT_TO_SERVER_EVENT.CLIENT_HEARTBEAT, (payload) => {
      const nowMs = Date.now()
      const token = sanitizeText((payload as { token?: string }).token)
      const roomCode = sanitizeRoomCode((payload as { roomCode?: string }).roomCode)
      const session = rooms.get(roomCode) ?? findSessionByToken(rooms, token)
      if (!session) return
      session.runtime = heartbeat(session.runtime, token, nowMs)
      if (token) {
        const playerId = session.runtime.playersByToken.get(token)
        if (playerId) {
          const player = session.runtime.playersById.get(playerId)
          if (player) {
            player.lastSeenAtMs = nowMs
            player.connected = true
          }
        }
      }
    })

    socket.on('disconnect', () => {
      const roomCode = socket.data.roomCode as string | undefined
      if (!roomCode) return
      const session = rooms.get(roomCode)
      if (!session) return
      const playerId = socket.data.playerId as string | undefined
      if (playerId) {
        const player = session.runtime.playersById.get(playerId)
        if (player) {
          player.connected = false
          player.lastSeenAtMs = Date.now()
        }
      }
      if (session.hostSocketId === socket.id) {
        session.hostSocketId = socket.id
      }
    })

    socket.on('error', (error) => {
      logger.warn('[quiz-board] socket error', error)
    })
  })
}

function broadcastSnapshot(io: SocketIOServer, session: RoomSession, nowMs: number): void {
  session.runtime = advanceRuntime(session.runtime, nowMs)
  const snapshot = createSnapshot(session.runtime, nowMs)
  const deadline = getDeadline(session.runtime.state)
  const enriched = {
    ...snapshot,
    joinUrl: session.joinUrl,
    hostJoinUrl: session.hostJoinUrl,
    playerJoinUrl: session.playerJoinUrl,
  } as RoomSnapshotShape & { joinUrl: string; hostJoinUrl: string; playerJoinUrl: string }
  io.to(session.runtime.room.code).emit(SERVER_TO_CLIENT_EVENT.SNAPSHOT, enriched)
  if (deadline) {
    io.to(session.runtime.room.code).emit(SERVER_TO_CLIENT_EVENT.DEADLINE, buildDeadline(deadline))
  }
  session.lastBroadcastAtMs = nowMs
}

function emitRoomCreated(io: SocketIOServer, session: RoomSession, nowMs: number): void {
  const snapshot = createSnapshot(session.runtime, nowMs)
  const payload = {
    roomId: session.runtime.room.id,
    roomCode: session.runtime.room.code,
    hostToken: session.runtime.hostToken,
    snapshot: {
      ...snapshot,
      joinUrl: session.joinUrl,
      hostJoinUrl: session.hostJoinUrl,
      playerJoinUrl: session.playerJoinUrl,
    },
    joinUrl: session.joinUrl,
    hostJoinUrl: session.hostJoinUrl,
    playerJoinUrl: session.playerJoinUrl,
  } as ServerRoomCreatedPayload & {
    joinUrl: string
    hostJoinUrl: string
    playerJoinUrl: string
  }
  io.to(session.runtime.room.code).emit(SERVER_TO_CLIENT_EVENT.ROOM_CREATED, payload)
}

function emitAck(socket: Socket, eventName: (typeof CLIENT_TO_SERVER_EVENT)[keyof typeof CLIENT_TO_SERVER_EVENT], nowMs: number): void {
  const payload: AckShape = {
    requestId: `${socket.id}:${eventName}:${nowMs}`,
    eventName,
    acceptedAtMs: nowMs,
  }
  socket.emit(SERVER_TO_CLIENT_EVENT.ACK, payload)
}

function emitError(socket: Socket, error: ErrorShape): void {
  socket.emit(SERVER_TO_CLIENT_EVENT.ERROR, error)
}

function emitPlayerToken(socket: Socket, playerToken: string, playerId: string): void {
  socket.emit(SERVER_TO_CLIENT_EVENT.PLAYER_TOKEN, { playerId, playerToken })
}

function buildDeadline(deadline: NonNullable<ReturnType<typeof getDeadline>>): DeadlineShape {
  return {
    deadlineId: `${deadline.eventName}:${deadline.startsAtMs}`,
    eventName: deadline.eventName,
    startsAtMs: deadline.startsAtMs,
    endsAtMs: deadline.endsAtMs,
  }
}

function createRoomSession(runtime: EngineRuntime, hostSocketId: string, urls: { joinUrl: string; hostJoinUrl: string }): RoomSession {
  return {
    runtime,
    hostSocketId,
    socketToRoomCode: new Map([[hostSocketId, runtime.room.code]]),
    socketToPlayerId: new Map(),
    playerIdToSocketId: new Map(),
    joinUrl: urls.joinUrl,
    hostJoinUrl: urls.hostJoinUrl,
    playerJoinUrl: urls.joinUrl,
    lastBroadcastAtMs: 0,
  }
}

function bindPlayerSession(session: RoomSession, socket: Socket, tokenSession: PlayerSession): void {
  const previousSocketId = session.playerIdToSocketId.get(tokenSession.playerId)
  if (previousSocketId && previousSocketId !== socket.id) {
    const previousSocket = socket.nsp.sockets.get(previousSocketId)
    previousSocket?.disconnect(true)
  }
  session.playerIdToSocketId.set(tokenSession.playerId, socket.id)
  session.socketToPlayerId.set(socket.id, tokenSession.playerId)
  session.socketToRoomCode.set(socket.id, session.runtime.room.code)
  socket.data.roomCode = session.runtime.room.code
  socket.data.playerId = tokenSession.playerId
  socket.data.playerToken = tokenSession.playerToken
}

function requireRoomSession(roomCode: string, rooms: Map<string, RoomSession>): RoomSession {
  const session = rooms.get(roomCode)
  if (!session) {
    throw createEngineError('room_not_found', `Room ${roomCode} was not found.`, false)
  }
  return session
}

function requireHostSession(socket: Socket, rooms: Map<string, RoomSession>): RoomSession {
  const roomCode = socket.data.roomCode as string | undefined
  if (!roomCode) {
    throw createEngineError('room_not_found', 'Host is not attached to a room.', false)
  }
  const session = requireRoomSession(roomCode, rooms)
  if (session.hostSocketId !== socket.id) {
    throw createEngineError('forbidden', 'Only the host socket can perform that action.', false)
  }
  return session
}

function requirePlayerSession(socket: Socket, rooms: Map<string, RoomSession>): RoomSession {
  const roomCode = socket.data.roomCode as string | undefined
  if (!roomCode) {
    throw createEngineError('room_not_found', 'The socket is not attached to a room.', false)
  }
  return requireRoomSession(roomCode, rooms)
}

function requirePlayerId(socket: Socket): string {
  const playerId = socket.data.playerId as string | undefined
  if (!playerId) {
    throw createEngineError('player_not_found', 'That socket is not attached to a player.', false)
  }
  return playerId
}

function findSessionByToken(rooms: Map<string, RoomSession>, token: string): RoomSession | undefined {
  for (const session of rooms.values()) {
    if (session.runtime.playersByToken.has(token)) {
      return session
    }
  }
  return undefined
}

function isAllowedClientEvent(eventName: string): boolean {
  return Object.values(CLIENT_TO_SERVER_EVENT).includes(eventName as (typeof CLIENT_TO_SERVER_EVENT)[keyof typeof CLIENT_TO_SERVER_EVENT])
}

function isForbiddenClientEvent(eventName: string): boolean {
  return eventName.startsWith('room/') || eventName.startsWith('game/') || eventName.startsWith('debug/')
}

function buildRoomUrls(baseUrl: string, roomCode: string): { joinUrl: string; hostJoinUrl: string } {
  return {
    joinUrl: `${baseUrl}/player?room=${encodeURIComponent(roomCode)}`,
    hostJoinUrl: `${baseUrl}/?room=${encodeURIComponent(roomCode)}`,
  }
}

function getPublicBaseUrl(socket: Socket, fallbackBaseUrl: string): string {
  const configured = getConfiguredPublicBaseUrl()
  if (configured) return configured

  const origin = socket.handshake.headers.origin
  if (typeof origin === 'string' && /^https?:\/\//.test(origin)) {
    return origin.replace(/\/$/, '')
  }

  const forwardedHost = socket.handshake.headers['x-forwarded-host']
  const forwardedProto = socket.handshake.headers['x-forwarded-proto']
  const host = Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost
  const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto
  if (host && proto) {
    return `${proto}://${host}`.replace(/\/$/, '')
  }

  return fallbackBaseUrl.replace(/\/$/, '')
}

function sanitizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function sanitizeRoomCode(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
}

function generateRoomCode(rooms: Map<string, RoomSession>): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let code = ''
    for (let index = 0; index < 4; index += 1) {
      code += alphabet[Math.floor(Math.random() * alphabet.length)]
    }
    if (!rooms.has(code)) return code
  }
  return `${alphabet[Math.floor(Math.random() * alphabet.length)]}${alphabet[Math.floor(Math.random() * alphabet.length)]}${alphabet[Math.floor(Math.random() * alphabet.length)]}${alphabet[Math.floor(Math.random() * alphabet.length)]}`
}

function getLanAddress(): string {
  const nets = networkInterfaces()
  for (const entries of Object.values(nets)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        return entry.address
      }
    }
  }
  return '127.0.0.1'
}

function getPublishedBaseUrl(port: number): string {
  const configured = getConfiguredPublicBaseUrl()
  if (configured) return configured

  const spaceHost = process.env.SPACE_HOST?.trim()
  if (spaceHost) return `https://${spaceHost}`.replace(/\/$/, '')

  return `http://${getLanAddress()}:${port}`
}

function getConfiguredPublicBaseUrl(): string {
  return sanitizeBaseUrl(process.env.PUBLIC_BASE_URL ?? process.env.RENDER_EXTERNAL_URL ?? process.env.PUBLIC_URL)
}

function sanitizeBaseUrl(value: string | undefined): string {
  if (!value) return ''
  return /^https?:\/\//.test(value) ? value.replace(/\/$/, '') : ''
}

async function listenOnAvailablePort(
  server: HttpServer,
  startPort: number,
  host: string,
  logger: Pick<Console, 'warn' | 'error'>,
): Promise<number> {
  if (startPort === 0) {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, host, () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (address && typeof address === 'object') {
      return address.port
    }
    throw new Error('Server did not report an address after binding port 0.')
  }
  for (let port = startPort; port < startPort + 20; port += 1) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          server.off('error', reject)
          resolve()
        })
      })
      return port
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EADDRINUSE') {
        logger.error('[quiz-board] failed to start server', error)
        throw error
      }
      logger.warn(`[quiz-board] port ${port} is busy, trying ${port + 1}`)
    }
  }
  throw new Error(`Unable to find an open port starting at ${startPort}`)
}

function fallback404(_req: IncomingMessage, res: ServerResponse): void {
  res.statusCode = 404
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.end('Not found')
}

async function serveProductionApp(req: IncomingMessage, res: ServerResponse, staticDir: string): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    fallback404(req, res)
    return
  }

  const url = new URL(req.url ?? '/', 'http://localhost')
  const pathname = safeDecodePath(url.pathname)
  if (!pathname) {
    fallback404(req, res)
    return
  }

  const root = resolve(staticDir)
  const relativeRequest = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  let filePath = resolve(root, relativeRequest)
  if (!isPathInside(root, filePath)) {
    fallback404(req, res)
    return
  }

  let fileStat = await stat(filePath).catch(() => undefined)
  if (!fileStat && extname(relativeRequest) === '') {
    filePath = resolve(root, 'index.html')
    fileStat = await stat(filePath).catch(() => undefined)
  }

  if (!fileStat || !fileStat.isFile()) {
    fallback404(req, res)
    return
  }

  const body = await readFile(filePath)
  res.statusCode = 200
  res.setHeader('Content-Type', contentTypeFor(filePath))
  if (relative(root, filePath).startsWith('assets/')) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
  } else {
    res.setHeader('Cache-Control', 'no-cache')
  }
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  res.end(body)
}

function safeDecodePath(pathname: string): string | undefined {
  try {
    return decodeURIComponent(pathname)
  } catch {
    return undefined
  }
}

function isPathInside(root: string, filePath: string): boolean {
  const rel = relative(root, filePath)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function contentTypeFor(filePath: string): string {
  switch (extname(filePath)) {
    case '.css':
      return 'text/css; charset=utf-8'
    case '.html':
      return 'text/html; charset=utf-8'
    case '.js':
      return 'text/javascript; charset=utf-8'
    case '.json':
      return 'application/json; charset=utf-8'
    case '.png':
      return 'image/png'
    case '.svg':
      return 'image/svg+xml'
    case '.webp':
      return 'image/webp'
    default:
      return 'application/octet-stream'
  }
}

function serveDiagnostics(req: IncomingMessage, res: ServerResponse, getBaseUrl: () => string): boolean {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname === '/healthz') {
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({
      ok: true,
      serverTime: new Date().toISOString(),
      baseUrl: getBaseUrl(),
      remoteAddress: req.socket.remoteAddress,
    }))
    return true
  }

  if (url.pathname === '/diagnostics') {
    const baseUrl = getBaseUrl()
    const localName = `${process.env.HOSTNAME ?? ''}` || 'unknown'
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Quiz Board Diagnostics</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 24px; line-height: 1.45; background: #101827; color: #f8fafc; }
    a { color: #7dd3fc; overflow-wrap: anywhere; }
    code, pre { background: #1f2937; border-radius: 8px; padding: 2px 6px; }
    .card { border: 1px solid #334155; border-radius: 12px; padding: 16px; margin: 16px 0; background: #172033; }
  </style>
</head>
<body>
  <h1>Quiz Board Diagnostics</h1>
  <div class="card">
    <p>If this page loads on your iPhone, the phone can reach the Mac server over the network.</p>
    <p><strong>Server URL:</strong> <a href="${baseUrl}/">${baseUrl}/</a></p>
    <p><strong>Player test:</strong> <a href="${baseUrl}/player?room=TEST">${baseUrl}/player?room=TEST</a></p>
    <p><strong>Health JSON:</strong> <a href="${baseUrl}/healthz">${baseUrl}/healthz</a></p>
  </div>
  <div class="card">
    <p><strong>Request remote address:</strong> <code>${req.socket.remoteAddress ?? 'unknown'}</code></p>
    <p><strong>Server host label:</strong> <code>${localName}</code></p>
    <p><strong>Rendered:</strong> <code>${new Date().toISOString()}</code></p>
  </div>
</body>
</html>`)
    return true
  }

  return false
}

async function serveViteIndex(vite: ViteDevServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') {
    fallback404(req, res)
    return
  }
  const url = req.url ?? '/'
  const html = await readFile(resolve(process.cwd(), 'index.html'), 'utf8')
  const transformed = await vite.transformIndexHtml(url, html)
  res.statusCode = 200
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.end(transformed)
}
