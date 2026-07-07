import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { get } from 'node:http'
import { afterEach, describe, expect, test } from 'vitest'
import { io, type Socket } from 'socket.io-client'
import {
  CLIENT_TO_SERVER_EVENT,
  SERVER_TO_CLIENT_EVENT,
  type RoomSnapshotShape,
  type ServerRoomCreatedPayload,
  type ServerPlayerTokenPayload,
  type ErrorShape,
} from '../../src/shared/protocol'
import { startGameServer, type GameServerHandle } from '../../server/gameServer'

function waitFor<T>(socket: Socket, eventName: string): Promise<T> {
  return new Promise((resolve) => {
    socket.once(eventName, resolve as never)
  })
}

let serverHandle: GameServerHandle | null = null
let tempDirs: string[] = []

afterEach(async () => {
  if (serverHandle) {
    await serverHandle.close()
    serverHandle = null
  }
  await Promise.all(tempDirs.map(async (dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

describe('quiz board server', () => {
  test('uses Hugging Face Space host for public join URLs when available', async () => {
    const previousSpaceHost = process.env.SPACE_HOST
    process.env.SPACE_HOST = 'stevetodman-cardiojeopardy.hf.space'
    try {
      serverHandle = await startGameServer({ dev: false, port: 0, logger: quietLogger() })
      const address = serverHandle.httpServer.address()
      if (!address || typeof address !== 'object') {
        throw new Error('Expected test server to expose a local port.')
      }

      const hostSocket = io(`http://127.0.0.1:${address.port}`, {
        autoConnect: true,
        transports: ['websocket'],
      })
      await waitFor(hostSocket, 'connect')

      hostSocket.emit(CLIENT_TO_SERVER_EVENT.HOST_CREATE_ROOM, {
        roomName: 'Hosted URL Room',
        hostName: 'Host',
      })

      const roomCreated = await waitFor<ServerRoomCreatedPayload & { joinUrl: string }>(hostSocket, SERVER_TO_CLIENT_EVENT.ROOM_CREATED)
      expect(serverHandle.baseUrl).toBe('https://stevetodman-cardiojeopardy.hf.space')
      expect(roomCreated.joinUrl).toBe(`https://stevetodman-cardiojeopardy.hf.space/player?room=${roomCreated.roomCode}`)

      hostSocket.disconnect()
    } finally {
      if (previousSpaceHost === undefined) {
        delete process.env.SPACE_HOST
      } else {
        process.env.SPACE_HOST = previousSpaceHost
      }
    }
  })

  test('uses forwarded host and proto for join URLs ahead of SPACE_HOST', async () => {
    const previousSpaceHost = process.env.SPACE_HOST
    process.env.SPACE_HOST = 'stevetodman-cardiojeopardy.hf.space'
    try {
      serverHandle = await startGameServer({ dev: false, port: 0, logger: quietLogger() })
      const address = serverHandle.httpServer.address()
      if (!address || typeof address !== 'object') {
        throw new Error('Expected test server to expose a local port.')
      }

      const hostSocket = io(`http://127.0.0.1:${address.port}`, {
        autoConnect: true,
        transports: ['websocket'],
        extraHeaders: {
          'x-forwarded-host': 'cards.example.org',
          'x-forwarded-proto': 'https',
        },
      })
      await waitFor(hostSocket, 'connect')

      hostSocket.emit(CLIENT_TO_SERVER_EVENT.HOST_CREATE_ROOM, {
        roomName: 'Forwarded URL Room',
        hostName: 'Host',
      })

      const roomCreated = await waitFor<ServerRoomCreatedPayload & { joinUrl: string }>(hostSocket, SERVER_TO_CLIENT_EVENT.ROOM_CREATED)
      expect(roomCreated.joinUrl).toBe(`https://cards.example.org/player?room=${roomCreated.roomCode}`)

      hostSocket.disconnect()
    } finally {
      if (previousSpaceHost === undefined) {
        delete process.env.SPACE_HOST
      } else {
        process.env.SPACE_HOST = previousSpaceHost
      }
    }
  })

  test('uses PUBLIC_BASE_URL ahead of forwarded headers', async () => {
    const previousSpaceHost = process.env.SPACE_HOST
    const previousPublicBaseUrl = process.env.PUBLIC_BASE_URL
    process.env.SPACE_HOST = 'stevetodman-cardiojeopardy.hf.space'
    process.env.PUBLIC_BASE_URL = 'https://public.example.net'
    try {
      serverHandle = await startGameServer({ dev: false, port: 0, logger: quietLogger() })
      const address = serverHandle.httpServer.address()
      if (!address || typeof address !== 'object') {
        throw new Error('Expected test server to expose a local port.')
      }

      const hostSocket = io(`http://127.0.0.1:${address.port}`, {
        autoConnect: true,
        transports: ['websocket'],
        extraHeaders: {
          'x-forwarded-host': 'cards.example.org',
          'x-forwarded-proto': 'https',
        },
      })
      await waitFor(hostSocket, 'connect')

      hostSocket.emit(CLIENT_TO_SERVER_EVENT.HOST_CREATE_ROOM, {
        roomName: 'Explicit Public URL Room',
        hostName: 'Host',
      })

      const roomCreated = await waitFor<ServerRoomCreatedPayload & { joinUrl: string }>(hostSocket, SERVER_TO_CLIENT_EVENT.ROOM_CREATED)
      expect(serverHandle.baseUrl).toBe('https://public.example.net')
      expect(roomCreated.joinUrl).toBe(`https://public.example.net/player?room=${roomCreated.roomCode}`)

      hostSocket.disconnect()
    } finally {
      if (previousPublicBaseUrl === undefined) {
        delete process.env.PUBLIC_BASE_URL
      } else {
        process.env.PUBLIC_BASE_URL = previousPublicBaseUrl
      }
      if (previousSpaceHost === undefined) {
        delete process.env.SPACE_HOST
      } else {
        process.env.SPACE_HOST = previousSpaceHost
      }
    }
  })

  test('reports stale host controls without crashing the server', async () => {
    serverHandle = await startGameServer({ dev: false, port: 0, logger: quietLogger() })

    const hostSocket = io(serverHandle.baseUrl, {
      autoConnect: true,
      transports: ['websocket'],
    })
    await waitFor(hostSocket, 'connect')

    hostSocket.emit(CLIENT_TO_SERVER_EVENT.HOST_RESUME, {})
    const staleControlError = await waitFor<ErrorShape>(hostSocket, SERVER_TO_CLIENT_EVENT.ERROR)
    expect(staleControlError.code).toBe('room_not_found')
    expect(staleControlError.retryable).toBe(false)

    hostSocket.emit(CLIENT_TO_SERVER_EVENT.HOST_CREATE_ROOM, {
      roomName: 'Crash Guard Room',
      hostName: 'Host',
    })

    const roomCreated = await waitFor<ServerRoomCreatedPayload & { joinUrl: string }>(hostSocket, SERVER_TO_CLIENT_EVENT.ROOM_CREATED)
    expect(roomCreated.roomCode).toBeTruthy()

    hostSocket.disconnect()
  })

  test('rejects forged mutations, restores rejoining players, and ignores client clock skew on heartbeat', async () => {
    serverHandle = await startGameServer({ dev: false, port: 0, logger: quietLogger() })

    const hostSocket = io(serverHandle.baseUrl, {
      autoConnect: true,
      transports: ['websocket'],
    })
    await waitFor(hostSocket, 'connect')

    hostSocket.emit(CLIENT_TO_SERVER_EVENT.HOST_CREATE_ROOM, {
      roomName: 'Server Test Room',
      hostName: 'Host',
    })

    const roomCreated = await waitFor<ServerRoomCreatedPayload & { joinUrl: string }>(hostSocket, SERVER_TO_CLIENT_EVENT.ROOM_CREATED)
    const roomCode = roomCreated.roomCode
    expect(roomCreated.snapshot.room.code).toBe(roomCode)

    const playerSocket = io(serverHandle.baseUrl, {
      autoConnect: true,
      transports: ['websocket'],
    })
    await waitFor(playerSocket, 'connect')
    playerSocket.emit(CLIENT_TO_SERVER_EVENT.PLAYER_JOIN, {
      roomCode,
      displayName: 'Jordan',
    })

    const playerTokenPayload = await waitFor<ServerPlayerTokenPayload>(playerSocket, SERVER_TO_CLIENT_EVENT.PLAYER_TOKEN)
    expect(playerTokenPayload.playerToken).toBeTruthy()

    const joinedSnapshot = await waitFor<RoomSnapshotShape>(playerSocket, SERVER_TO_CLIENT_EVENT.SNAPSHOT)
    const joinedPlayer = joinedSnapshot.room.players.find((player) => player.id === playerTokenPayload.playerId)
    expect(joinedPlayer?.connected).toBe(true)

    playerSocket.emit('room/setScore', { roomCode, score: 12345 })
    const forgedError = await waitFor<ErrorShape>(playerSocket, SERVER_TO_CLIENT_EVENT.ERROR)
    expect(forgedError.code).toBe('forbidden_event')

    playerSocket.disconnect()

    const rejoinSocket = io(serverHandle.baseUrl, {
      autoConnect: true,
      transports: ['websocket'],
    })
    await waitFor(rejoinSocket, 'connect')
    rejoinSocket.emit(CLIENT_TO_SERVER_EVENT.PLAYER_REJOIN, {
      roomCode,
      displayName: 'Jordan',
      playerToken: playerTokenPayload.playerToken,
    })

    const rejoinToken = await waitFor<ServerPlayerTokenPayload>(rejoinSocket, SERVER_TO_CLIENT_EVENT.PLAYER_TOKEN)
    expect(rejoinToken.playerToken).toBe(playerTokenPayload.playerToken)
    const rejoinSnapshot = await waitFor<RoomSnapshotShape>(rejoinSocket, SERVER_TO_CLIENT_EVENT.SNAPSHOT)
    const rejoinedPlayer = rejoinSnapshot.room.players.find((player) => player.id === playerTokenPayload.playerId)
    expect(rejoinedPlayer?.connected).toBe(true)

    const skewedSentAt = Date.now() + 3_600_000
    const heartbeatSnapshotPromise = waitFor<RoomSnapshotShape>(rejoinSocket, SERVER_TO_CLIENT_EVENT.SNAPSHOT)
    rejoinSocket.emit(CLIENT_TO_SERVER_EVENT.CLIENT_HEARTBEAT, {
      sentAtMs: skewedSentAt,
      roomCode,
      playerId: playerTokenPayload.playerId,
      token: playerTokenPayload.playerToken,
    })
    const heartbeatSnapshot = await heartbeatSnapshotPromise
    const heartbeatPlayer = heartbeatSnapshot.room.players.find((player) => player.id === playerTokenPayload.playerId)
    expect(heartbeatPlayer?.lastSeenAtMs).toBeLessThan(skewedSentAt - 1_000_000)
    expect(heartbeatPlayer?.lastSeenAtMs).toBeGreaterThan(Date.now() - 5_000)

    rejoinSocket.disconnect()
    hostSocket.disconnect()
  })

  test('serves the built app shell and static assets in production mode', async () => {
    const distRoot = await mkdtemp(join(tmpdir(), 'quiz-board-dist-'))
    tempDirs.push(distRoot)
    const distDir = resolve(distRoot, 'dist')
    await mkdir(resolve(distDir, 'assets'), { recursive: true })
    await writeFile(resolve(distDir, 'index.html'), '<!doctype html><html><body><main id="app">built shell</main></body></html>')
    await writeFile(resolve(distDir, 'assets', 'main.css'), 'body{background:#123456;}')

    serverHandle = await startGameServer({ dev: false, port: 0, staticDir: distDir, logger: quietLogger() })

    const appShell = await httpGet(`${serverHandle.baseUrl}/player?room=AB12`)
    expect(appShell.statusCode).toBe(200)
    expect(appShell.headers['content-type']).toContain('text/html')
    expect(appShell.body).toContain('built shell')

    const asset = await httpGet(`${serverHandle.baseUrl}/assets/main.css`)
    expect(asset.statusCode).toBe(200)
    expect(asset.headers['content-type']).toContain('text/css')
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    expect(asset.body).toContain('background:#123456')
  })
})

function quietLogger(): Pick<Console, 'log' | 'warn' | 'error'> {
  return {
    log() {},
    warn() {},
    error() {},
  }
}

function httpGet(url: string): Promise<{ statusCode: number | undefined; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolvePromise, reject) => {
    get(url, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      })
      response.on('end', () => {
        resolvePromise({
          statusCode: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      })
      response.on('error', reject)
    }).on('error', reject)
  })
}
