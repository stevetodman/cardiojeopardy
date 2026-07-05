import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import App from '../../src/App'
import type { BoardClueState, Room, RoomStatus } from '../../src/shared/types'
import type { RoomSnapshotShape, ServerRoomCreatedPayload } from '../../src/shared/protocol'

type SocketHandler = (payload?: unknown) => void

interface MockSocket {
  connected: boolean
  emit: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  off: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
  trigger: (eventName: string, payload?: unknown) => void
}

let socketMock: MockSocket

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => socketMock),
}))

vi.mock('qrcode', () => ({
  default: {
    toDataURL: vi.fn(async (value: string) => `data:text/plain,${encodeURIComponent(value)}`),
  },
}))

describe('host smoke', () => {
  beforeEach(() => {
    localStorage.clear()
    window.history.replaceState({}, '', '/')
    socketMock = createSocketMock()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  test('creates a room and renders join assets from the server snapshot', async () => {
    const user = userEvent.setup()
    render(<App />)

    socketMock.trigger('connect')
    await user.click(screen.getByRole('button', { name: 'Create room' }))

    expect(socketMock.emit).toHaveBeenCalledWith('host/createRoom', {
      roomName: 'Peds Cardio Quiz Board',
      hostName: 'Host',
    })

    const created = makeRoomCreatedPayload()
    await act(async () => {
      socketMock.trigger('server/roomCreated', created)
    })

    expect(screen.getByRole('link', { name: serverJoinUrl('AB12') })).toHaveAttribute('href', serverJoinUrl('AB12'))
    expect(screen.getByAltText(`QR code for ${serverJoinUrl('AB12')}`)).toBeInTheDocument()
  })

  test('renders the active clue, scores, final reveal, and post-game review', async () => {
    render(<App />)

    socketMock.trigger('connect')
    await act(async () => {
      socketMock.trigger('server/snapshot', makeClueSnapshot())
    })

    expect(await screen.findByRole('heading', { name: 'Prompt one question' })).toBeInTheDocument()
    expect(screen.getByText('Prompt 1')).toBeInTheDocument()

    await act(async () => {
      socketMock.trigger('server/snapshot', makeGameOverSnapshot())
    })

    expect(await screen.findByText('Final ranking')).toBeInTheDocument()
    expect(screen.getByText('Post-game review')).toBeInTheDocument()
    expect(screen.getAllByText('Prompt one question').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Prompt two question').length).toBeGreaterThan(0)
    expect(screen.getByText('Final clue prompt')).toBeInTheDocument()
  })
})

function createSocketMock(): MockSocket {
  const handlers = new Map<string, SocketHandler[]>()

  const socket: MockSocket = {
    connected: false,
    emit: vi.fn(),
    on: vi.fn((eventName: string, handler: SocketHandler) => {
      const next = handlers.get(eventName) ?? []
      next.push(handler)
      handlers.set(eventName, next)
      return socket
    }),
    off: vi.fn((eventName: string, handler?: SocketHandler) => {
      if (!handler) {
        handlers.delete(eventName)
        return socket
      }
      const next = (handlers.get(eventName) ?? []).filter((entry) => entry !== handler)
      if (next.length) {
        handlers.set(eventName, next)
      } else {
        handlers.delete(eventName)
      }
      return socket
    }),
    disconnect: vi.fn(() => {
      socket.connected = false
      return socket
    }),
    trigger(eventName: string, payload?: unknown) {
      if (eventName === 'connect') {
        socket.connected = true
      }
      for (const handler of handlers.get(eventName) ?? []) {
        handler(payload)
      }
    },
  }

  return socket
}

function serverJoinUrl(roomCode: string) {
  return `http://192.168.2.31:5173/player?room=${encodeURIComponent(roomCode)}`
}

function makeRoomCreatedPayload(): ServerRoomCreatedPayload {
  const snapshot = makeLobbySnapshot()
  return {
    roomId: snapshot.room.id,
    roomCode: snapshot.room.code,
    hostToken: 'host-token-1',
    snapshot,
    joinUrl: serverJoinUrl(snapshot.room.code),
    playerJoinUrl: serverJoinUrl(snapshot.room.code),
    hostJoinUrl: `http://192.168.2.31:5173/?room=${encodeURIComponent(snapshot.room.code)}`,
  }
}

function makeLobbySnapshot(): RoomSnapshotShape {
  return {
    room: makeRoom('setup'),
    content: makeContent(),
    state: {
      state: 'RoomLobby',
      room: makeRoom('setup'),
      readyAtMs: Date.now() + 15_000,
    },
    generatedAtMs: Date.now(),
  }
}

function makeClueSnapshot(): RoomSnapshotShape {
  const content = makeContent()
  const room = makeRoom('active')
  const clue: BoardClueState = {
    ...content.boardCategories[0].clues[0],
    status: 'reading',
    selectedByPlayerId: 'player-1',
  }

  return {
    room: {
      ...room,
      currentClueId: clue.id,
      currentTeamId: room.teams[0].id,
    },
    content,
    state: {
      state: 'ClueReading',
      room,
      clue,
      startedAtMs: Date.now() - 2_000,
      endsAtMs: Date.now() + 18_000,
    },
    generatedAtMs: Date.now(),
  }
}

function makeGameOverSnapshot(): RoomSnapshotShape {
  const content = makeContent()
  const room = makeRoom('complete')
  return {
    room,
    content,
    state: {
      state: 'GameOver',
      room,
      finalScores: {
        alpha: 1200,
        bravo: 900,
      },
      winnerTeamId: 'alpha',
      endedAtMs: Date.now(),
    },
    generatedAtMs: Date.now(),
  }
}

function makeRoom(status: RoomStatus): Room {
  return {
    id: 'room-1',
    code: 'AB12',
    name: 'Peds Cardio Quiz Board',
    hostPlayerId: 'host-1',
    status,
    contentId: 'dataset-1',
    roundNumber: 1,
    createdAtMs: Date.now() - 60_000,
    updatedAtMs: Date.now(),
    players: [
      {
        id: 'host-1',
        displayName: 'Host',
        teamId: 'alpha',
        isHost: true,
        connected: true,
        joinedAtMs: Date.now() - 60_000,
        lastSeenAtMs: Date.now(),
      },
      {
        id: 'player-2',
        displayName: 'Taylor',
        teamId: 'bravo',
        isHost: false,
        connected: false,
        joinedAtMs: Date.now() - 30_000,
        lastSeenAtMs: Date.now() - 10_000,
      },
    ],
    teams: [
      {
        id: 'alpha',
        name: 'Alpha',
        color: '#7fe5ff',
        score: 1200,
      },
      {
        id: 'bravo',
        name: 'Bravo',
        color: '#ffd56e',
        score: 900,
      },
    ],
  }
}

function makeContent() {
  const references = [{ id: 'ref-1', label: 'Local case note', sourceType: 'local-file' as const, filePath: '/tmp/reference.md', supports: 'host smoke test' }]

  return {
    id: 'dataset-1',
    title: 'Smoke test set',
    description: 'Minimal host smoke dataset.',
    version: '1.0.0',
    references,
    boardCategories: [
      {
        id: 'cat-1',
        title: 'Category One',
        description: 'Smoke board',
        clues: [
          makeClue('clue-1', 'cat-1', 100, 'Prompt one question', ['Prompt 1', 'Prompt 2'], 'Prompt 1'),
          makeClue('clue-2', 'cat-1', 200, 'Prompt two question', ['Prompt 3', 'Prompt 4'], 'Prompt 3'),
        ],
      },
      {
        id: 'cat-2',
        title: 'Category Two',
        description: 'Smoke board',
        clues: [
          makeClue('clue-3', 'cat-2', 100, 'Prompt three question', ['Prompt 5', 'Prompt 6'], 'Prompt 5'),
          makeClue('clue-4', 'cat-2', 200, 'Prompt four question', ['Prompt 7', 'Prompt 8'], 'Prompt 7'),
        ],
      },
    ],
    finalClue: {
      id: 'final-1',
      prompt: 'Final clue prompt',
      answerChoices: ['Prompt A', 'Prompt B'],
      correctAnswerId: 'Prompt A',
      explanation: 'Final explanation',
      references,
    },
  }
}

function makeClue(
  clueId: string,
  categoryId: string,
  value: number,
  clue: string,
  answerChoices: readonly string[],
  correctAnswerId: string,
) {
  return {
    id: clueId,
    categoryId,
    value,
    clue,
    prompt: clue,
    answerChoices,
    correctAnswerId,
    explanation: 'Explanation',
    references: [{ id: `${clueId}-ref`, label: 'Local case note', sourceType: 'local-file' as const, filePath: '/tmp/reference.md', supports: 'host smoke test' }],
  }
}
