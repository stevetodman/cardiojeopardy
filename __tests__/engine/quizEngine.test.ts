import { describe, expect, test } from 'vitest'
import type { BoardCategory, BoardClueTemplate, ContentDataset, FinalClue, Reference } from '../../src/shared/types'
import {
  ANSWER_WINDOW_MS,
  FINAL_INTRO_MS,
  ROUND_INTRO_MS,
  ROUND_TRANSITION_MS,
  WAGER_WINDOW_MS,
} from '../../src/shared/protocol'
import {
  ADJUDICATION_MS,
  CLUE_READING_MS,
  RESOLUTION_MS,
  advanceRuntime,
  createRuntime,
  hostFinalOverride,
  isFinalAnswerCorrect,
  joinPlayer,
  normalizeFinalAnswer,
  rejoinPlayer,
  resumeRoom,
  selectClue,
  submitAnswerChoice,
  submitBuzz,
  submitFinalAnswer,
  submitWager,
} from '../../src/engine/quizEngine'

const references: Reference[] = [
  {
    id: 'ref-1',
    label: 'Synthetic test reference',
    sourceType: 'web',
    url: 'https://example.com',
    supports: 'Synthetic test content.',
  },
]

function makeClue(
  id: string,
  value: number,
  correctAnswerId: string,
  answerChoices: readonly string[] = ['correct', 'wrong'],
  doubleDown = false,
): BoardClueTemplate {
  return {
    id,
    categoryId: 'cat-1',
    value,
    clue: `${id} clue`,
    prompt: `${id} prompt`,
    answerChoices,
    correctAnswerId,
    explanation: `${id} explanation`,
    references,
    doubleDown,
  }
}

function makeTestContent(oneClue = false): ContentDataset {
  const clues = oneClue ? [makeClue('clue-300', 300, 'correct', ['correct', 'wrong'], true)] : [makeClue('clue-100', 100, 'correct'), makeClue('clue-300', 300, 'correct')]
  const categories: BoardCategory[] = [
    {
      id: 'cat-1',
      title: 'Test Category',
      description: 'Synthetic board for engine tests.',
      clues,
    },
  ]
  const finalClue: FinalClue = {
    id: 'final-1',
    prompt: 'Final prompt',
    answerChoices: ['ductus', 'oxygen', 'syncope'],
    correctAnswerId: 'ductus',
    explanation: 'Synthetic final clue.',
    references,
  }
  return {
    id: oneClue ? 'test-content-final' : 'test-content-buzz',
    title: 'Test Board',
    description: 'Synthetic test content',
    version: '1',
    references,
    boardCategories: categories,
    finalClue,
  }
}

function buildBoardRuntime(nowMs = 0, oneClue = false) {
  const content = makeTestContent(oneClue)
  let runtime = createRuntime({
    roomCode: 'ABCD',
    roomName: 'Test Room',
    hostName: 'Host',
    content,
    nowMs,
  })
  const playerJoin = joinPlayer(runtime, 'Jordan', 'team-2', nowMs)
  runtime = playerJoin.runtime
  const player = playerJoin.player!
  runtime = resumeRoom(runtime, nowMs)
  nowMs += ROUND_INTRO_MS + 1
  runtime = advanceRuntime(runtime, nowMs)
  return { runtime, nowMs, content, player }
}

describe('quiz engine', () => {
  test('routes board control, buzz order, rebound lockout, and negative scores through the server-authoritative state machine', () => {
    let nowMs = 0
    const { runtime: afterStart, player } = buildBoardRuntime(nowMs)
    let runtime = afterStart

    expect(runtime.state.state).toBe('BoardIdle')
    expect(runtime.room.currentTeamId).toBe(player.teamId)

    const hostId = runtime.room.hostPlayerId
    runtime = selectClue(runtime, player.id, 'clue-100', nowMs)
    expect(runtime.state.state).toBe('ClueReading')

    nowMs += CLUE_READING_MS + 1
    runtime = advanceRuntime(runtime, nowMs)
    expect(runtime.state.state).toBe('BuzzWindow')

    runtime = submitBuzz(runtime, player.id, 'clue-100', nowMs)
    expect(runtime.state.state).toBe('TeamAnswering')
    expect(() => submitBuzz(runtime, hostId, 'clue-100', nowMs)).toThrow()

    nowMs += 1
    runtime = submitAnswerChoice(runtime, player.id, 'clue-100', 'wrong', nowMs)
    nowMs += ADJUDICATION_MS + RESOLUTION_MS + 1
    runtime = advanceRuntime(runtime, nowMs)
    expect(runtime.state.state).toBe('ClueResolution')

    nowMs += RESOLUTION_MS + 1
    runtime = advanceRuntime(runtime, nowMs)
    expect(runtime.state.state).toBe('BuzzWindow')
    expect(runtime.playersById.get(player.id)?.mutedUntilMs ?? 0).toBeGreaterThan(nowMs)
    expect(() => submitBuzz(runtime, player.id, 'clue-100', nowMs)).toThrow()

    runtime = submitBuzz(runtime, hostId, 'clue-100', nowMs)
    runtime = submitAnswerChoice(runtime, hostId, 'clue-100', 'correct', nowMs)
    nowMs += ADJUDICATION_MS + RESOLUTION_MS + 1
    runtime = advanceRuntime(runtime, nowMs)
    expect(runtime.state.state).toBe('ClueResolution')

    nowMs += RESOLUTION_MS + 1
    runtime = advanceRuntime(runtime, nowMs)
    expect(runtime.state.state).toBe('BoardIdle')
    expect(runtime.room.teams.find((team) => team.id === player.teamId)?.score).toBe(-100)
    expect(runtime.room.currentTeamId).toBe(runtime.playersById.get(hostId)?.teamId)
    expect(() => selectClue(runtime, player.id, 'clue-300', nowMs)).toThrow()
  })

  test('clamps double-down and final wagers, then supports host final override during reveal', () => {
    let nowMs = 0
    const content = makeTestContent(true)
    let runtime = createRuntime({
      roomCode: 'WAGE',
      roomName: 'Wager Room',
      hostName: 'Host',
      content,
      nowMs,
    })
    const playerJoin = joinPlayer(runtime, 'Jordan', 'team-2', nowMs)
    runtime = playerJoin.runtime
    const player = playerJoin.player!
    runtime = resumeRoom(runtime, nowMs)
    nowMs += ROUND_INTRO_MS + 1
    runtime = advanceRuntime(runtime, nowMs)

    runtime = selectClue(runtime, runtime.room.hostPlayerId, 'clue-300', nowMs)
    expect(runtime.state.state).toBe('DoubleDownWager')
    runtime = submitWager(runtime, runtime.room.hostPlayerId, 999, nowMs)
    const doubleDownTeamId = runtime.playersById.get(runtime.room.hostPlayerId)?.teamId ?? ''
    expect(runtime.doubleDownWagersByClueId['clue-300']).toBe(999)
    expect(doubleDownTeamId).toBeTruthy()

    nowMs += CLUE_READING_MS + 1
    runtime = advanceRuntime(runtime, nowMs)
    expect(runtime.state.state).toBe('TeamAnswering')
    runtime = submitAnswerChoice(runtime, runtime.room.hostPlayerId, 'clue-300', 'correct', nowMs)
    nowMs += ADJUDICATION_MS + RESOLUTION_MS + 1
    runtime = advanceRuntime(runtime, nowMs)
    expect(runtime.state.state).toBe('ClueResolution')

    nowMs += RESOLUTION_MS + 1
    runtime = advanceRuntime(runtime, nowMs)
    expect(runtime.state.state).toBe('RoundTransition')

    nowMs += ROUND_TRANSITION_MS + 1
    runtime = advanceRuntime(runtime, nowMs)
    expect(runtime.state.state).toBe('FinalIntro')

    nowMs += FINAL_INTRO_MS + 1
    runtime = advanceRuntime(runtime, nowMs)
    expect(runtime.state.state).toBe('FinalWagering')

    const finalHostTeamId = runtime.playersById.get(runtime.room.hostPlayerId)?.teamId ?? ''
    runtime = submitWager(runtime, runtime.room.hostPlayerId, 999, nowMs)
    runtime = submitWager(runtime, player.id, 50, nowMs)
    expect(runtime.finalWagersByTeamId[finalHostTeamId]).toBe(999)
    expect(runtime.finalWagersByTeamId[player.teamId]).toBe(0)

    nowMs += WAGER_WINDOW_MS + 1
    runtime = advanceRuntime(runtime, nowMs)
    expect(runtime.state.state).toBe('FinalAnswering')

    runtime = submitFinalAnswer(runtime, runtime.room.hostPlayerId, '  THE DUCTUS!!  ', nowMs)
    runtime = submitFinalAnswer(runtime, player.id, 'bronchus', nowMs)
    expect(isFinalAnswerCorrect(runtime.finalClueState, '  THE DUCTUS!!  ')).toBe(true)
    expect(isFinalAnswerCorrect(runtime.finalClueState, 'bronchus')).toBe(false)

    nowMs += ANSWER_WINDOW_MS + 1
    runtime = advanceRuntime(runtime, nowMs)
    expect(runtime.state.state).toBe('FinalReveal')

    const beforeOverride = runtime.room.teams.find((team) => team.id === finalHostTeamId)?.score ?? 0
    runtime = hostFinalOverride(
      runtime,
      {
        teamId: finalHostTeamId,
        wager: 300,
        correct: false,
        answerId: 'oxygen',
      },
      nowMs,
    )
    expect(runtime.room.teams.find((team) => team.id === finalHostTeamId)?.score).toBe(beforeOverride - 300)
  })

  test('normalizes final answers by trimming articles, punctuation, whitespace, and small typos', () => {
    const runtime = createRuntime({
      roomCode: 'MATH',
      roomName: 'Normalization Room',
      hostName: 'Host',
      content: makeTestContent(true),
      nowMs: 0,
    })
    expect(normalizeFinalAnswer('  The   Ductus!! ')).toBe('ductus')
    expect(isFinalAnswerCorrect(runtime.finalClueState, 'The Ductus!!')).toBe(true)
    expect(isFinalAnswerCorrect(runtime.finalClueState, 'doctus')).toBe(true)
    expect(isFinalAnswerCorrect(runtime.finalClueState, 'bronchus')).toBe(false)
  })

  test('restores a disconnected team answerer before the deadline and times out if they do not return', () => {
    let nowMs = 0
    let runtime = createRuntime({
      roomCode: 'RECON',
      roomName: 'Reconnect Room',
      hostName: 'Host',
      content: makeTestContent(false),
      nowMs,
    })
    const playerJoin = joinPlayer(runtime, 'Jordan', 'team-2', nowMs)
    runtime = playerJoin.runtime
    const player = playerJoin.player!
    runtime = resumeRoom(runtime, nowMs)
    nowMs += ROUND_INTRO_MS + 1
    runtime = advanceRuntime(runtime, nowMs)
    runtime = selectClue(runtime, runtime.room.hostPlayerId, 'clue-100', nowMs)
    nowMs += CLUE_READING_MS + 1
    runtime = advanceRuntime(runtime, nowMs)
    expect(runtime.state.state).toBe('BuzzWindow')
    runtime = submitBuzz(runtime, player.id, 'clue-100', nowMs)

    const token = player.token
    runtime.playersById.get(player.id)!.connected = false
    nowMs += ANSWER_WINDOW_MS / 2
    runtime = advanceRuntime(runtime, nowMs)
    expect(runtime.state.state).toBe('TeamAnswering')

    const rejoined = rejoinPlayer(runtime, 'Jordan', token, nowMs)
    runtime = rejoined.runtime
    expect(runtime.playersById.get(player.id)?.connected).toBe(true)
    expect(runtime.state.state).toBe('TeamAnswering')

    nowMs += ANSWER_WINDOW_MS + 1
    runtime = advanceRuntime(runtime, nowMs)
    expect(runtime.state.state === 'TeamAnswering').toBe(false)
  })
})
