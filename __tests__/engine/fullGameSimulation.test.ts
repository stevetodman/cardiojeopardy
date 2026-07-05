import { describe, expect, test } from 'vitest'
import clues from '../../src/content/clues.json'
import { normalizeQuizContentDataset } from '../../src/engine/quizContent'
import {
  ADJUDICATION_MS,
  CLUE_READING_MS,
  RESOLUTION_MS,
  advanceRuntime,
  createRuntime,
  joinPlayer,
  resumeRoom,
  selectClue,
  submitAnswerChoice,
  submitBuzz,
  submitFinalAnswer,
  submitWager,
} from '../../src/engine/quizEngine'
import {
  ANSWER_WINDOW_MS,
  DOUBLE_DOWN_ROUND_ONE_CAP,
  DOUBLE_DOWN_ROUND_TWO_CAP,
  FINAL_INTRO_MS,
  FINAL_REVEAL_MS,
  ROUND_INTRO_MS,
  ROUND_TRANSITION_MS,
  WAGER_WINDOW_MS,
} from '../../src/shared/protocol'

const dataset = normalizeQuizContentDataset(clues)
const boardClues = dataset.boardCategories
  .flatMap((category) => category.clues)
  .slice()
  .sort((left, right) => {
    const leftRound = left.round ?? 1
    const rightRound = right.round ?? 1
    return leftRound - rightRound || left.value - right.value || left.id.localeCompare(right.id)
  })

function advanceToRoundIdle(runtime: ReturnType<typeof createRuntime>, nowMs: number) {
  while (runtime.state.state === 'RoundTransition' || runtime.state.state === 'RoundIntro') {
    nowMs += runtime.state.state === 'RoundTransition' ? ROUND_TRANSITION_MS + 1 : ROUND_INTRO_MS + 1
    runtime = advanceRuntime(runtime, nowMs)
  }

  return { runtime, nowMs }
}

describe('full game simulation', () => {
  test('completes the verified board and reaches GameOver', () => {
    let nowMs = 0
    let runtime = createRuntime({
      roomCode: 'FULL',
      roomName: 'Full Game',
      hostName: 'Host',
      content: dataset,
      nowMs,
    })
    const secondPlayerJoin = joinPlayer(runtime, 'Jordan', 'team-2', nowMs)
    runtime = secondPlayerJoin.runtime
    const hostPlayerId = runtime.room.hostPlayerId
    expect(runtime.playersById.get(hostPlayerId)).toBeTruthy()

    runtime = resumeRoom(runtime, nowMs)
    nowMs += ROUND_INTRO_MS + 1
    runtime = advanceRuntime(runtime, nowMs)
    expect(runtime.state.state).toBe('BoardIdle')

    for (const clue of boardClues) {
      if (runtime.state.state !== 'BoardIdle') {
        const settled = advanceToRoundIdle(runtime, nowMs)
        runtime = settled.runtime
        nowMs = settled.nowMs
      }

      expect(runtime.room.roundNumber).toBe(clue.round ?? 1)
      expect(runtime.state.state).toBe('BoardIdle')

      runtime = selectClue(runtime, hostPlayerId, clue.id, nowMs)

      if (clue.doubleDown) {
        const cap = clue.round === 1 ? DOUBLE_DOWN_ROUND_ONE_CAP : DOUBLE_DOWN_ROUND_TWO_CAP
        runtime = submitWager(runtime, hostPlayerId, Math.min(clue.value, cap), nowMs)
      }

      nowMs += CLUE_READING_MS + 1
      runtime = advanceRuntime(runtime, nowMs)

      if (!clue.doubleDown) {
        expect(runtime.state.state).toBe('BuzzWindow')
        runtime = submitBuzz(runtime, hostPlayerId, clue.id, nowMs)
        runtime = submitAnswerChoice(runtime, hostPlayerId, clue.id, clue.correctAnswerId, nowMs)
      } else {
        expect(runtime.state.state).toBe('TeamAnswering')
        runtime = submitAnswerChoice(runtime, hostPlayerId, clue.id, clue.correctAnswerId, nowMs)
      }

      nowMs += ADJUDICATION_MS + 1
      runtime = advanceRuntime(runtime, nowMs)
      expect(runtime.state.state).toBe('ClueResolution')

      nowMs += RESOLUTION_MS + 1
      runtime = advanceRuntime(runtime, nowMs)
    }

    nowMs += ROUND_TRANSITION_MS + 1
    runtime = advanceRuntime(runtime, nowMs)
    expect(runtime.state.state).toBe('FinalIntro')

    nowMs += FINAL_INTRO_MS + 1
    runtime = advanceRuntime(runtime, nowMs)
    expect(runtime.state.state).toBe('FinalWagering')

    runtime = submitWager(runtime, hostPlayerId, 100, nowMs)
    nowMs += WAGER_WINDOW_MS + 1
    runtime = advanceRuntime(runtime, nowMs)
    expect(runtime.state.state).toBe('FinalAnswering')

    runtime = submitFinalAnswer(runtime, hostPlayerId, dataset.finalClue.correctAnswerId, nowMs)
    nowMs += ANSWER_WINDOW_MS + 1
    runtime = advanceRuntime(runtime, nowMs)
    expect(runtime.state.state).toBe('FinalReveal')

    nowMs += FINAL_REVEAL_MS + 1
    runtime = advanceRuntime(runtime, nowMs)
    expect(runtime.state.state).toBe('GameOver')
    expect(runtime.room.status).toBe('complete')
    expect(runtime.room.teams.some((team) => team.score !== 0)).toBe(true)
  })
})
