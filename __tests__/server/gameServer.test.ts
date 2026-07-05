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

afterEach(async () => {
  if (serverHandle) {
    await serverHandle.close()
    serverHandle = null
  }
})

describe('quiz board server', () => {
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
})

function quietLogger(): Pick<Console, 'log' | 'warn' | 'error'> {
  return {
    log() {},
    warn() {},
    error() {},
  }
}
