import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import PlayerView from '../../src/client/PlayerView'
import { CLIENT_TO_SERVER_EVENT, SERVER_TO_CLIENT_EVENT, type RoomSnapshotShape } from '../../src/shared/protocol'

type HandlerMap = Map<string, Set<(payload: unknown) => void>>

function createFakeSocket() {
  const handlers: HandlerMap = new Map()
  const emitted: Array<{ eventName: string; payload: unknown }> = []

  return {
    emitted,
    connect: vi.fn(),
    disconnect: vi.fn(),
    close: vi.fn(),
    isConnected: vi.fn(() => true),
    send: vi.fn((eventName, payload) => {
      emitted.push({ eventName, payload })
    }),
    on(eventName: string, handler: (payload: unknown) => void) {
      if (!handlers.has(eventName)) {
        handlers.set(eventName, new Set())
      }
      handlers.get(eventName)!.add(handler)
      return () => {
        handlers.get(eventName)?.delete(handler)
      }
    },
    emitServer(eventName: string, payload: unknown) {
      handlers.get(eventName)?.forEach((handler) => handler(payload))
    },
  }
}

describe('player view', () => {
  beforeEach(() => {
    localStorage.clear()
    window.history.replaceState({}, '', '/player?room=AB12')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('joins, restores a token, and follows server-only gameplay screens', async () => {
    const user = userEvent.setup()
    const socket = createFakeSocket()
    const { rerender } = render(<PlayerView socketFactory={() => socket as never} />)

    await user.type(screen.getByLabelText('Display name'), 'Avery')
    await user.click(screen.getByRole('button', { name: 'Join room' }))

    expect(socket.connect).toHaveBeenCalled()
    expect(socket.send).toHaveBeenCalledWith(
      CLIENT_TO_SERVER_EVENT.PLAYER_JOIN,
      expect.objectContaining({ roomCode: 'AB12', displayName: 'Avery' }),
    )

    await act(async () => {
      socket.emitServer(SERVER_TO_CLIENT_EVENT.PLAYER_TOKEN, { playerId: 'p1', playerToken: 'token-1' })
      socket.emitServer(SERVER_TO_CLIENT_EVENT.SNAPSHOT, buildSnapshot('BoardIdle'))
    })

    expect(await screen.findByText('Board control')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Select clue' }))
    expect(socket.send).toHaveBeenCalledWith(
      CLIENT_TO_SERVER_EVENT.PLAYER_SELECT_CLUE,
      expect.objectContaining({ clueId: 'clue-1' }),
    )

    await act(async () => {
      socket.emitServer(SERVER_TO_CLIENT_EVENT.SNAPSHOT, buildSnapshot('BuzzWindow'))
    })
    expect(await screen.findByRole('button', { name: 'Buzz' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Buzz' }))
    expect(socket.send).toHaveBeenCalledWith(
      CLIENT_TO_SERVER_EVENT.PLAYER_BUZZ,
      expect.objectContaining({ clueId: 'clue-1' }),
    )

    await act(async () => {
      socket.emitServer(SERVER_TO_CLIENT_EVENT.SNAPSHOT, buildSnapshot('TeamAnswering'))
    })
    expect(await screen.findByText('Team answer')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Answer A' }))
    expect(socket.send).toHaveBeenCalledWith(
      CLIENT_TO_SERVER_EVENT.PLAYER_ANSWER_CHOICE,
      expect.objectContaining({ clueId: 'clue-1', choiceId: 'Answer A' }),
    )

    await act(async () => {
      socket.emitServer(SERVER_TO_CLIENT_EVENT.SNAPSHOT, buildSnapshot('FinalWagering'))
    })
    expect(await screen.findByText('Final wager')).toBeInTheDocument()

    await act(async () => {
      socket.emitServer(SERVER_TO_CLIENT_EVENT.SNAPSHOT, buildSnapshot('FinalAnswering'))
    })
    expect(await screen.findByText('Final answer')).toBeInTheDocument()
    await user.type(screen.getByLabelText('Type your answer'), 'VSD')
    await user.click(screen.getByRole('button', { name: 'Submit answer' }))
    expect(socket.send).toHaveBeenCalledWith(
      CLIENT_TO_SERVER_EVENT.PLAYER_SUBMIT_FINAL_ANSWER,
      expect.objectContaining({ finalClueId: 'final-1', choiceId: 'VSD' }),
    )

    await act(async () => {
      socket.emitServer(SERVER_TO_CLIENT_EVENT.SNAPSHOT, buildSnapshot('GameOver'))
    })
    expect(await screen.findByText('Game over')).toBeInTheDocument()
    expect(within(screen.getByText('Game over').closest('.player-summary') as HTMLElement).getByText('Blue')).toBeInTheDocument()

    rerender(<PlayerView socketFactory={() => socket as never} />)
  })

  test('prefills a saved session and can rejoin on load', async () => {
    localStorage.setItem(
      'simcitypedscards.player.session.v1',
      JSON.stringify({
        roomCode: 'AB12',
        displayName: 'Jordan',
        playerToken: 'token-2',
        playerId: 'p2',
        updatedAtMs: Date.now(),
      }),
    )

    const socket = createFakeSocket()
    render(<PlayerView socketFactory={() => socket as never} />)

    expect(await screen.findByText('Connecting')).toBeInTheDocument()
    expect(socket.connect).toHaveBeenCalled()
    expect(socket.send).toHaveBeenCalledWith(
      CLIENT_TO_SERVER_EVENT.PLAYER_REJOIN,
      expect.objectContaining({ roomCode: 'AB12', displayName: 'Jordan', playerToken: 'token-2' }),
    )
  })
})

function buildSnapshot(state: RoomSnapshotShape['state']['state']): RoomSnapshotShape {
  const room: RoomSnapshotShape['room'] = {
    id: 'room-1',
    code: 'AB12',
    name: 'Room 12',
    hostPlayerId: 'host-1',
    status: 'active',
    contentId: 'content-1',
    roundNumber: 1,
    currentClueId: 'clue-1',
    currentTeamId: 'team-blue',
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    players: [
      {
        id: 'p1',
        displayName: 'Avery',
        teamId: 'team-blue',
        isHost: false,
        connected: true,
        token: 'token-1',
        joinedAtMs: Date.now(),
        lastSeenAtMs: Date.now(),
      },
      {
        id: 'p2',
        displayName: 'Jordan',
        teamId: 'team-blue',
        isHost: false,
        connected: true,
        token: 'token-2',
        joinedAtMs: Date.now(),
        lastSeenAtMs: Date.now(),
      },
    ],
    teams: [
      { id: 'team-blue', name: 'Blue', color: '#00f', score: 1200 },
      { id: 'team-red', name: 'Red', color: '#f00', score: 900 },
    ],
  }

  const boardClue = {
    id: 'clue-1',
    categoryId: 'cat-1',
    value: 200,
    clue: 'Synthetic board clue',
    prompt: 'What rhythm is this?',
    answerChoices: ['Answer A', 'Answer B', 'Answer C', 'Answer D'],
    correctAnswerId: 'Answer A',
    explanation: 'Synthetic educational case.',
    references: [],
  } as const

  const finalClue: RoomSnapshotShape['content']['finalClue'] = {
    id: 'final-1',
    prompt: 'Final question',
    answerChoices: ['VSD', 'TOF', 'ASD', 'PDA'],
    correctAnswerId: 'VSD',
    explanation: 'Synthetic educational final.',
    references: [],
  }

  const content: RoomSnapshotShape['content'] = {
    id: 'content-1',
    title: 'Synthetic set',
    description: 'Test content',
    version: '1.0',
    references: [],
    boardCategories: [
      {
        id: 'cat-1',
        title: 'Rhythm',
        description: 'Synthetic',
        clues: [boardClue],
      },
    ],
    finalClue,
  }

  switch (state) {
    case 'BoardIdle':
      return {
        room,
        content,
        state: {
          state,
          room,
          roundNumber: 1,
          availableClueIds: ['clue-1'],
        },
        generatedAtMs: Date.now(),
      }
    case 'BuzzWindow':
      return {
        room,
        content,
        state: {
          state,
          room,
          clueId: 'clue-1',
          openAtMs: Date.now(),
          closesAtMs: Date.now() + 10000,
        },
        generatedAtMs: Date.now(),
      }
    case 'TeamAnswering':
      return {
        room,
        content,
        state: {
          state,
          room,
          clueId: 'clue-1',
          teamId: 'team-blue',
          answerStartedAtMs: Date.now(),
          answerDueAtMs: Date.now() + 10000,
        },
        generatedAtMs: Date.now(),
      }
    case 'FinalWagering':
      return {
        room,
        content,
        state: {
          state,
          room,
          finalClueId: 'final-1',
          teams: room.teams,
          wagerDueAtMs: Date.now() + 10000,
        },
        generatedAtMs: Date.now(),
      }
    case 'FinalAnswering':
      return {
        room,
        content,
        state: {
          state,
          room,
          finalClueId: 'final-1',
          answerDueAtMs: Date.now() + 10000,
          wagerByTeamId: { 'team-blue': 300 },
        },
        generatedAtMs: Date.now(),
      }
    case 'GameOver':
      return {
        room,
        content,
        state: {
          state,
          room,
          finalScores: { 'team-blue': 1800, 'team-red': 900 },
          winnerTeamId: 'team-blue',
          endedAtMs: Date.now(),
        },
        generatedAtMs: Date.now(),
      }
    default:
      throw new Error(`Unsupported state for smoke test: ${state}`)
  }
}
