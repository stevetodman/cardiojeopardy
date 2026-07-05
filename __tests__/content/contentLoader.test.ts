import { describe, expect, test } from 'vitest'
import clues from '../../src/content/clues.json'
import { normalizeQuizContentDataset } from '../../src/engine/quizContent'

describe('content loader normalizer', () => {
  test('normalizes the verified JSON shape into round-scoped categories and final aliases', () => {
    const normalized = normalizeQuizContentDataset(clues)

    expect(normalized.boardCategories).toHaveLength(10)
    expect(normalized.boardCategories.flatMap((category) => category.clues)).toHaveLength(50)

    const roundOneCategories = normalized.boardCategories.filter((category) =>
      category.clues.every((clue) => clue.round === 1),
    )
    const roundTwoCategories = normalized.boardCategories.filter((category) =>
      category.clues.every((clue) => clue.round === 2),
    )

    expect(roundOneCategories).toHaveLength(5)
    expect(roundTwoCategories).toHaveLength(5)

    expect(normalized.boardCategories.filter((category) => category.clues.some((clue) => clue.doubleDown))).toHaveLength(3)
    expect(normalized.boardCategories.flatMap((category) => category.clues.filter((clue) => clue.doubleDown))).toHaveLength(3)
    expect(normalized.finalClue.aliases).toEqual(clues.finalClue.aliases)
    expect(normalized.finalClue.aliases).toHaveLength(4)
  })
})
