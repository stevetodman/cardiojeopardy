import { describe, expect, test } from 'vitest'
import clues from '../../src/content/clues.json'

interface BoardClue {
  id: string
  round: 1 | 2
  category: string
  value: number
  tier: number
  prompt: string
  choices: string[]
  correctIndex: number
  explanation: string
  references: string[]
  doubleDown: boolean
}

interface FinalClue {
  category: string
  prompt: string
  correctAnswer: string
  aliases: string[]
  explanation: string
  references: string[]
}

const dataset = clues as { boardClues: BoardClue[]; finalClue: FinalClue }
const roundOneCategories = ['Murmurs & Auscultation', 'Cyanosis & Saturations', 'ECG Basics', 'Chest Pain & Syncope', 'First Steps in Stabilization']
const roundTwoCategories = ['Congenital Heart Lesions', 'Arrhythmias & Channelopathies', 'Post-op & ICU Cardiology', 'Echo & Imaging Basics', 'Medications & Guidelines']
const placeholderPattern = /\b(TODO|TBD|lorem|xxx)\b/i

describe('verified clue content', () => {
  test('ships exactly two 5x5 rounds and one final clue', () => {
    expect(dataset.boardClues).toHaveLength(50)
    expect(dataset.finalClue).toBeTruthy()
    expect(dataset.finalClue.correctAnswer).toBeTruthy()
    expect(dataset.finalClue.aliases.length).toBeGreaterThan(0)

    for (const [round, categories, values] of [
      [1, roundOneCategories, [200, 400, 600, 800, 1000]],
      [2, roundTwoCategories, [400, 800, 1200, 1600, 2000]],
    ] as const) {
      for (const category of categories) {
        const categoryClues = dataset.boardClues.filter((clue) => clue.round === round && clue.category === category)
        expect(categoryClues.map((clue) => clue.value).sort((left, right) => left - right)).toEqual(values)
      }
    }
  })

  test('enforces references, explanations, clean stems, and choice quality', () => {
    const ids = new Set<string>()
    for (const clue of dataset.boardClues) {
      expect(ids.has(clue.id)).toBe(false)
      ids.add(clue.id)
      expect(clue.prompt).not.toMatch(/\bexcept\b/i)
      expect(clue.prompt).not.toMatch(placeholderPattern)
      expect(clue.choices).toHaveLength(4)
      expect(new Set(clue.choices).size).toBe(4)
      expect(clue.choices.join(' ')).not.toMatch(/all of the above|a and c/i)
      expect(clue.correctIndex).toBeGreaterThanOrEqual(0)
      expect(clue.correctIndex).toBeLessThan(4)
      expect(clue.explanation.length).toBeGreaterThanOrEqual(200)
      expect(clue.references.length).toBeGreaterThanOrEqual(1)
      for (const reference of clue.references) {
        expect(reference).toMatch(/^https:\/\//)
      }
    }

    expect(dataset.finalClue.prompt).not.toMatch(/\bexcept\b/i)
    expect(dataset.finalClue.explanation.length).toBeGreaterThanOrEqual(200)
    expect(dataset.finalClue.references.length).toBeGreaterThanOrEqual(1)
    for (const reference of dataset.finalClue.references) {
      expect(reference).toMatch(/^https:\/\//)
    }
  })

  test('keeps answer positions balanced and double downs constrained', () => {
    const distribution = [0, 0, 0, 0]
    for (const clue of dataset.boardClues) {
      distribution[clue.correctIndex] += 1
    }
    expect(distribution.every((count) => count >= 10 && count <= 15)).toBe(true)

    const roundOneDoubleDowns = dataset.boardClues.filter((clue) => clue.round === 1 && clue.doubleDown)
    const roundTwoDoubleDowns = dataset.boardClues.filter((clue) => clue.round === 2 && clue.doubleDown)
    expect(roundOneDoubleDowns).toHaveLength(1)
    expect(roundTwoDoubleDowns).toHaveLength(2)
    for (const clue of [...roundOneDoubleDowns, ...roundTwoDoubleDowns]) {
      expect(clue.tier).toBeGreaterThanOrEqual(3)
      expect(clue.tier).toBeLessThanOrEqual(5)
    }
  })
})
