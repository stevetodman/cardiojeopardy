import { z } from 'zod'
import type { BoardCategory, BoardClueTemplate, ContentDataset, FinalClue, Reference } from '../shared/types'

const referenceSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  sourceType: z.enum(['web', 'local-file']),
  url: z.string().url().optional(),
  filePath: z.string().min(1).optional(),
  supports: z.string().min(1),
}).superRefine((reference, ctx) => {
  if (reference.sourceType === 'web' && !reference.url) {
    ctx.addIssue({ code: 'custom', path: ['url'], message: 'Web references require url.' })
  }
  if (reference.sourceType === 'local-file' && !reference.filePath) {
    ctx.addIssue({ code: 'custom', path: ['filePath'], message: 'Local-file references require filePath.' })
  }
})

const clueSchema = z.object({
  id: z.string().min(1),
  categoryId: z.string().min(1),
  category: z.string().optional(),
  round: z.union([z.literal(1), z.literal(2)]).optional(),
  tier: z.number().int().min(1).max(5).optional(),
  value: z.number().int(),
  clue: z.string().min(1),
  prompt: z.string().min(1),
  answerChoices: z.array(z.string().min(1)).min(2),
  correctAnswerId: z.string().min(1),
  explanation: z.string().min(1),
  references: z.array(referenceSchema).min(1),
  doubleDown: z.boolean().optional(),
})

const categorySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  clues: z.array(clueSchema).min(1),
})

const finalClueSchema = z.object({
  id: z.string().min(1),
  category: z.string().optional(),
  prompt: z.string().min(1),
  answerChoices: z.array(z.string().min(1)).default([]),
  correctAnswerId: z.string().min(1),
  correctAnswer: z.string().optional(),
  aliases: z.array(z.string().min(1)).default([]),
  explanation: z.string().min(1),
  references: z.array(referenceSchema).min(1),
})

export const quizContentSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  version: z.string().min(1),
  references: z.array(referenceSchema).default([]),
  boardCategories: z.array(categorySchema).min(1),
  finalClue: finalClueSchema,
})

export type QuizContentDataset = ContentDataset

export function normalizeQuizContentDataset(input: unknown): ContentDataset {
  return quizContentSchema.parse(toSharedContentDataset(input)) as ContentDataset
}

function toSharedContentDataset(input: unknown): unknown {
  if (!isRecord(input) || !Array.isArray(input.boardClues)) {
    return input
  }

  const references = new Map<string, Reference>()
  const categories = new Map<string, BoardCategory>()
  for (const rawClue of input.boardClues) {
    if (!isRecord(rawClue)) continue
    const categoryTitle = String(rawClue.category ?? 'Uncategorized')
    const categoryId = slugify(categoryTitle)
    const clueReferences = normalizeReferences(rawClue.references, references)
    const choices = Array.isArray(rawClue.choices) ? rawClue.choices.map(String) : []
    const correctIndex = Number(rawClue.correctIndex ?? 0)
    const correctAnswer = choices[correctIndex] ?? choices[0] ?? ''
    const clue: BoardClueTemplate = {
      id: String(rawClue.id),
      categoryId,
      category: categoryTitle,
      round: rawClue.round === 2 ? 2 : 1,
      tier: Number(rawClue.tier ?? 1),
      value: Number(rawClue.value ?? 0),
      clue: correctAnswer,
      prompt: String(rawClue.prompt ?? ''),
      answerChoices: choices,
      correctAnswerId: correctAnswer,
      explanation: String(rawClue.explanation ?? ''),
      references: clueReferences,
      doubleDown: Boolean(rawClue.doubleDown),
    }
    const existing = categories.get(categoryId)
    if (existing) {
      categories.set(categoryId, { ...existing, clues: [...existing.clues, clue].sort((left, right) => left.value - right.value) })
    } else {
      categories.set(categoryId, {
        id: categoryId,
        title: categoryTitle,
        description: clue.round ? `Round ${clue.round}` : undefined,
        clues: [clue],
      })
    }
  }

  const rawFinal = isRecord(input.finalClue) ? input.finalClue : {}
  const finalReferences = normalizeReferences(rawFinal.references, references)
  const correctAnswer = String(rawFinal.correctAnswer ?? '')
  const aliases = Array.isArray(rawFinal.aliases) ? rawFinal.aliases.map(String) : []
  const finalClue: FinalClue = {
    id: String(rawFinal.id ?? 'final-clue'),
    category: String(rawFinal.category ?? 'Final Round'),
    prompt: String(rawFinal.prompt ?? ''),
    answerChoices: aliases,
    correctAnswerId: correctAnswer,
    correctAnswer,
    aliases,
    explanation: String(rawFinal.explanation ?? ''),
    references: finalReferences,
  }

  return {
    id: 'peds-cardio-verified-v1',
    title: 'Pediatric Cardiology Quiz Board',
    description: 'Verified pediatric cardiology teaching clues for a local multiplayer quiz-board game.',
    version: '1.0.0',
    references: Array.from(references.values()),
    boardCategories: Array.from(categories.values()),
    finalClue,
  }
}

function normalizeReferences(rawReferences: unknown, accumulator: Map<string, Reference>): Reference[] {
  const urls = Array.isArray(rawReferences) ? rawReferences.map(String) : []
  return urls.map((url, index) => {
    const id = `ref-${slugify(url).slice(0, 48) || index}`
    const reference: Reference = {
      id,
      label: url,
      sourceType: 'web',
      url,
      supports: 'Supports this clue in the verified content audit.',
    }
    accumulator.set(id, reference)
    return reference
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'item'
}

export function createFallbackContentDataset(): ContentDataset {
  const references: Reference[] = [
    {
      id: 'fallback-general-reference',
      label: 'Fallback educational reference',
      sourceType: 'web',
      url: 'https://www.heart.org/',
      supports: 'Fallback content for local development and tests.',
    },
  ]

  const categoryA: BoardCategory = {
    id: 'category-murmur-basics',
    title: 'Murmur basics',
    description: 'A small fallback board for engine boot and tests.',
    clues: [
      buildClue('murmur-100', 'category-murmur-basics', 100, 'Soft systolic murmur', 'Vibratory', 'Vibratory, positional murmur', references),
      buildClue('murmur-200', 'category-murmur-basics', 200, 'Click and crescendo', 'Pathologic', 'Click plus harsh quality suggests pathology', references),
      buildClue('murmur-300', 'category-murmur-basics', 300, 'Highest value clue', 'Double down', 'Highest value clue triggers wager flow in the fallback board', references),
    ],
  }

  const categoryB: BoardCategory = {
    id: 'category-cyanosis',
    title: 'Cyanosis',
    description: 'A second fallback category.',
    clues: [
      buildClue('cyanosis-100', 'category-cyanosis', 100, 'Oxygen barely helps', 'Ductal', 'Low oxygen response suggests mixing physiology', references),
      buildClue('cyanosis-200', 'category-cyanosis', 200, 'Single loud S2', 'TGA', 'Single S2 can suggest transposition', references),
      buildClue('cyanosis-300', 'category-cyanosis', 300, 'PGE1', 'Keep duct open', 'Prostaglandin keeps the ductus open in ductal-dependent lesions', references),
    ],
  }

  const finalClue: FinalClue = {
    id: 'final-fallback',
    prompt: 'Which clue is the safest fallback answer?',
    answerChoices: ['compromise', 'oxygen', 'ductus', 'syncope'],
    correctAnswerId: 'ductus',
    explanation: 'The fallback board is intentionally simple and only exists to keep engine tests deterministic.',
    references,
  }

  return {
    id: 'fallback-quiz-board',
    title: 'Peds Cardio Quiz Board',
    description: 'Fallback quiz board content for development and tests.',
    version: '0.0.0-fallback',
    references,
    boardCategories: [categoryA, categoryB],
    finalClue,
  }
}

function buildClue(
  id: string,
  categoryId: string,
  value: number,
  clue: string,
  prompt: string,
  explanation: string,
  references: readonly Reference[],
): BoardClueTemplate {
  return {
    id,
    categoryId,
    value,
    clue,
    prompt,
    answerChoices: ['choice-a', 'choice-b', 'choice-c'],
    correctAnswerId: 'choice-b',
    explanation,
    references,
  }
}
