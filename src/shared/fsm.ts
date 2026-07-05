import type { BoardClueState, FinalClueState, Room, Team } from './types'

export interface SetupState {
  state: 'Setup'
  createdAtMs: number
  reason?: 'boot' | 'reset'
}

export interface RoomLobbyState {
  state: 'RoomLobby'
  room: Room
  readyAtMs?: number
}

export interface RoundIntroState {
  state: 'RoundIntro'
  room: Room
  roundNumber: number
  headline: string
  endsAtMs: number
}

export interface BoardIdleState {
  state: 'BoardIdle'
  room: Room
  roundNumber: number
  availableClueIds: readonly string[]
  selectedClueId?: string
}

export interface ClueReadingState {
  state: 'ClueReading'
  room: Room
  clue: BoardClueState
  startedAtMs: number
  endsAtMs: number
}

export interface BuzzWindowState {
  state: 'BuzzWindow'
  room: Room
  clueId: string
  openAtMs: number
  closesAtMs: number
  buzzedByPlayerId?: string
}

export interface TeamAnsweringState {
  state: 'TeamAnswering'
  room: Room
  clueId: string
  teamId: string
  answerStartedAtMs: number
  answerDueAtMs: number
  submittedAnswerId?: string
}

export interface AdjudicationState {
  state: 'Adjudication'
  room: Room
  clueId: string
  teamId: string
  answerId?: string
  buzzedByPlayerId?: string
  hostOverridePending: boolean
}

export interface ClueResolutionState {
  state: 'ClueResolution'
  room: Room
  clueId: string
  result: 'correct' | 'incorrect' | 'timeout' | 'forfeit' | 'double-down'
  scoreDelta: number
}

export interface DoubleDownWagerState {
  state: 'DoubleDownWager'
  room: Room
  clueId: string
  teamId: string
  minimumWager: number
  maximumWager: number
  submittedWager?: number
}

export interface RoundTransitionState {
  state: 'RoundTransition'
  room: Room
  fromRoundNumber: number
  toRoundNumber: number
  endsAtMs: number
}

export interface FinalIntroState {
  state: 'FinalIntro'
  room: Room
  finalClue: FinalClueState
  startsAtMs: number
}

export interface FinalWageringState {
  state: 'FinalWagering'
  room: Room
  finalClueId: string
  teams: readonly Team[]
  wagerDueAtMs: number
}

export interface FinalAnsweringState {
  state: 'FinalAnswering'
  room: Room
  finalClueId: string
  answerDueAtMs: number
  wagerByTeamId: Readonly<Record<string, number>>
}

export interface FinalRevealState {
  state: 'FinalReveal'
  room: Room
  finalClue: FinalClueState
  revealedAtMs: number
}

export interface GameOverState {
  state: 'GameOver'
  room: Room
  finalScores: Readonly<Record<string, number>>
  winnerTeamId?: string
  endedAtMs: number
}

export type FsmState =
  | SetupState
  | RoomLobbyState
  | RoundIntroState
  | BoardIdleState
  | ClueReadingState
  | BuzzWindowState
  | TeamAnsweringState
  | AdjudicationState
  | ClueResolutionState
  | DoubleDownWagerState
  | RoundTransitionState
  | FinalIntroState
  | FinalWageringState
  | FinalAnsweringState
  | FinalRevealState
  | GameOverState

export interface GameStartedEvent {
  type: 'GAME_STARTED'
  roomId: string
  startedAtMs: number
}

export interface RoundStartedEvent {
  type: 'ROUND_STARTED'
  roomId: string
  roundNumber: number
  startedAtMs: number
}

export interface ClueSelectedEvent {
  type: 'CLUE_SELECTED'
  roomId: string
  clueId: string
  playerId: string
  selectedAtMs: number
}

export interface ClueOpenedEvent {
  type: 'CLUE_OPENED'
  roomId: string
  clueId: string
  openedAtMs: number
}

export interface BuzzReceivedEvent {
  type: 'BUZZ_RECEIVED'
  roomId: string
  clueId: string
  playerId: string
  buzzedAtMs: number
}

export interface AnswerSubmittedEvent {
  type: 'ANSWER_SUBMITTED'
  roomId: string
  clueId: string
  playerId: string
  teamId: string
  answerId: string
  submittedAtMs: number
}

export interface AnswerJudgedEvent {
  type: 'ANSWER_JUDGED'
  roomId: string
  clueId: string
  teamId: string
  result: 'correct' | 'incorrect' | 'timeout' | 'forfeit' | 'double-down'
  scoreDelta: number
  judgedAtMs: number
}

export interface WagerSubmittedEvent {
  type: 'WAGER_SUBMITTED'
  roomId: string
  clueId: string
  teamId: string
  wager: number
  submittedAtMs: number
}

export interface FinalWagerSubmittedEvent {
  type: 'FINAL_WAGER_SUBMITTED'
  roomId: string
  finalClueId: string
  teamId: string
  wager: number
  submittedAtMs: number
}

export interface FinalAnswerSubmittedEvent {
  type: 'FINAL_ANSWER_SUBMITTED'
  roomId: string
  finalClueId: string
  teamId: string
  answerId: string
  submittedAtMs: number
}

export interface FinalRevealedEvent {
  type: 'FINAL_REVEALED'
  roomId: string
  finalClueId: string
  revealedAtMs: number
}

export interface GameOverEvent {
  type: 'GAME_OVER'
  roomId: string
  endedAtMs: number
  finalScores: Readonly<Record<string, number>>
}

export interface PlayerJoinedEvent {
  type: 'PLAYER_JOINED'
  roomId: string
  playerId: string
  teamId: string
  joinedAtMs: number
}

export interface PlayerDisconnectedEvent {
  type: 'PLAYER_DISCONNECTED'
  roomId: string
  playerId: string
  disconnectedAtMs: number
}

export interface PlayerRejoinedEvent {
  type: 'PLAYER_REJOINED'
  roomId: string
  playerId: string
  rejoinedAtMs: number
}

export interface HeartbeatTimeoutEvent {
  type: 'HEARTBEAT_TIMEOUT'
  roomId: string
  playerId: string
  timedOutAtMs: number
}

export interface KickPlayerEvent {
  type: 'KICK_PLAYER'
  roomId: string
  playerId: string
  kickedByPlayerId?: string
  kickedAtMs: number
  reason?: string
}

export type FsmEvent =
  | GameStartedEvent
  | RoundStartedEvent
  | ClueSelectedEvent
  | ClueOpenedEvent
  | BuzzReceivedEvent
  | AnswerSubmittedEvent
  | AnswerJudgedEvent
  | WagerSubmittedEvent
  | FinalWagerSubmittedEvent
  | FinalAnswerSubmittedEvent
  | FinalRevealedEvent
  | GameOverEvent
  | PlayerJoinedEvent
  | PlayerDisconnectedEvent
  | PlayerRejoinedEvent
  | HeartbeatTimeoutEvent
  | KickPlayerEvent

