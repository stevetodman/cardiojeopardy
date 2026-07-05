export type ReferenceSource = 'web' | 'local-file'

export interface Reference {
  id: string
  label: string
  sourceType: ReferenceSource
  url?: string
  filePath?: string
  supports: string
}

export type ClueStatus =
  | 'locked'
  | 'available'
  | 'selected'
  | 'reading'
  | 'buzzing'
  | 'answering'
  | 'adjudicating'
  | 'resolved'
  | 'expired'

export interface BoardClueTemplate {
  id: string
  categoryId: string
  category?: string
  round?: 1 | 2
  tier?: number
  value: number
  clue: string
  prompt: string
  answerChoices: readonly string[]
  correctAnswerId: string
  explanation: string
  references: readonly Reference[]
  doubleDown?: boolean
}

export interface BoardClueState extends BoardClueTemplate {
  status: ClueStatus
  selectedByPlayerId?: string
  buzzedByPlayerId?: string
  answeredByTeamId?: string
  wager?: number
}

export interface FinalClue {
  id: string
  category?: string
  prompt: string
  answerChoices: readonly string[]
  correctAnswerId: string
  correctAnswer?: string
  aliases?: readonly string[]
  explanation: string
  references: readonly Reference[]
}

export interface FinalClueState extends FinalClue {
  status: ClueStatus
  wagerByTeamId: Readonly<Record<string, number>>
  answerByTeamId: Readonly<Record<string, string>>
}

export interface BoardCategory {
  id: string
  title: string
  description?: string
  clues: readonly BoardClueTemplate[]
}

export interface ContentDataset {
  id: string
  title: string
  description: string
  version: string
  references: readonly Reference[]
  boardCategories: readonly BoardCategory[]
  finalClue: FinalClue
}

export interface Team {
  id: string
  name: string
  color: string
  score: number
  wager?: number
  finalAnswerId?: string
  finalAnswerText?: string
}

export interface Player {
  id: string
  displayName: string
  teamId: string
  isHost: boolean
  connected: boolean
  token?: string
  joinedAtMs: number
  lastSeenAtMs: number
  mutedUntilMs?: number
}

export type RoomStatus = 'setup' | 'lobby' | 'active' | 'paused' | 'complete'

export interface Room {
  id: string
  code: string
  name: string
  hostPlayerId: string
  status: RoomStatus
  contentId: string
  roundNumber: number
  currentClueId?: string
  currentTeamId?: string
  createdAtMs: number
  updatedAtMs: number
  players: readonly Player[]
  teams: readonly Team[]
}

export interface Snapshot<TState = unknown> {
  room: Room
  content: ContentDataset
  state: TState
  generatedAtMs: number
}
