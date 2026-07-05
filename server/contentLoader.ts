import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ContentDataset } from '../src/shared/types'
import { createFallbackContentDataset, normalizeQuizContentDataset } from '../src/engine/quizContent'

export function loadQuizBoardContent(): ContentDataset {
  const contentPath = resolve(process.cwd(), 'src/content/clues.json')
  if (!existsSync(contentPath)) {
    return createFallbackContentDataset()
  }

  try {
    const raw = readFileSync(contentPath, 'utf8')
    return normalizeQuizContentDataset(JSON.parse(raw))
  } catch {
    return createFallbackContentDataset()
  }
}

