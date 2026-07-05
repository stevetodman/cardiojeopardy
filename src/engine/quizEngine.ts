import { randomUUID } from 'node:crypto'
import type {
  BoardCategory,
  BoardClueState,
  ContentDataset,
  FinalClue,
  FinalClueState,
  Player,
  Room,
  Snapshot,
  Team,
} from '../shared/types'
import {
  ANSWER_WINDOW_MS,
  BUZZ_WINDOW_MS,
  CLIENT_TO_SERVER_EVENT,
  DOUBLE_DOWN_WAGER_MAX,
  DOUBLE_DOWN_WAGER_MIN,
  DOUBLE_DOWN_ROUND_ONE_CAP,
  DOUBLE_DOWN_ROUND_TWO_CAP,
  FINAL_INTRO_MS,
  FINAL_REVEAL_MS,
  FINAL_WAGER_MAX,
  FINAL_WAGER_MIN,
  FORBIDDEN_CLIENT_EVENT_NAMES,
  ROUND_INTRO_MS,
  ROUND_TRANSITION_MS,
  WAGER_WINDOW_MS,
} from '../shared/protocol'
import type {
  AdjudicationState,
  BuzzWindowState,
  ClueReadingState,
  ClueResolutionState,
  DoubleDownWagerState,
  FinalAnsweringState,
  FinalIntroState,
  FinalRevealState,
  FinalWageringState,
  FsmState,
  GameOverState,
  RoomLobbyState,
  RoundIntroState,
  RoundTransitionState,
  TeamAnsweringState,
} from '../shared/fsm'
import { createFallbackContentDataset } from './quizContent'

export const MAX_PLAYERS = 6
export const TEAM_COUNT = 2
export const CLUE_READING_MS = 5_000
export const ADJUDICATION_MS = 2_000
export const RESOLUTION_MS = 1_000
export const REBOUND_LOCKOUT_MS = 5_000
export const SPECTATOR_TEAM_ID = 'spectator'
const TEAM_COLORS = ['#38bdf8', '#f59e0b', '#22c55e', '#f43f5e', '#a78bfa', '#14b8a6'] as const

export const ALLOWED_CLIENT_EVENTS = new Set<string>(Object.values(CLIENT_TO_SERVER_EVENT))
export const FORBIDDEN_CLIENT_EVENTS = new Set<string>(FORBIDDEN_CLIENT_EVENT_NAMES)

export interface CreateRuntimeInput {
  roomCode: string
  roomName: string
  hostName: string
  content?: ContentDataset
  nowMs: number
}

export interface PlayerSession {
  playerId: string
  playerToken: string
}

export interface RuntimePlayer extends Player {
  token: string
  spectator: boolean
}

export interface PendingJudgment {
  clueId: string
  teamId: string
  answerId: string
  answerText: string
  submittedAtMs: number
  buzzedByPlayerId?: string
  correct?: boolean
  scoreDelta?: number
  result?: 'correct' | 'incorrect' | 'timeout' | 'forfeit' | 'double-down'
}

export interface EngineRuntime {
  room: Room
  content: ContentDataset
  state: FsmState
  hostToken: string
  playersById: Map<string, RuntimePlayer>
  playersByToken: Map<string, string>
  clueById: Map<string, BoardClueState>
  finalClueState: FinalClueState
  pendingJudgment?: PendingJudgment
  adjudicationDueAtMs?: number
  resolutionReadyAtMs?: number
  doubleDownWagerDueAtMs?: number
  finalWagersByTeamId: Record<string, number>
  finalAnswersByTeamId: Record<string, string>
  doubleDownWagersByClueId: Record<string, number>
  pausedAtMs?: number
  kickedPlayerIds: Set<string>
}

export interface MutationResult {
  runtime: EngineRuntime
  player?: RuntimePlayer
  session?: PlayerSession
}

export class EngineError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly details?: Readonly<Record<string, unknown>>

  constructor(code: string, message: string, retryable: boolean, details?: Readonly<Record<string, unknown>>) {
    super(message)
    this.code = code
    this.retryable = retryable
    this.details = details
  }
}

export function createEngineError(
  code: string,
  message: string,
  retryable: boolean,
  details?: Readonly<Record<string, unknown>>,
): EngineError {
  return new EngineError(code, message, retryable, details)
}

export function createRuntime(input: CreateRuntimeInput): EngineRuntime {
  const content = input.content ?? createFallbackContentDataset()
  const teams = createTeams()
  const hostPlayerId = createId('player')
  const hostToken = createToken()
  const hostPlayer: RuntimePlayer = {
    id: hostPlayerId,
    displayName: input.hostName.trim() || 'Host',
    teamId: teams[0]?.id ?? 'team-1',
    isHost: true,
    connected: true,
    token: hostToken,
    joinedAtMs: input.nowMs,
    lastSeenAtMs: input.nowMs,
    spectator: false,
  }

  const playersById = new Map<string, RuntimePlayer>([[hostPlayer.id, hostPlayer]])
  const playersByToken = new Map<string, string>([[hostToken, hostPlayer.id]])
  const clueById = buildClueMap(content.boardCategories)
  const finalClueState = buildFinalClueState(content.finalClue)
  const room: Room = {
    id: createId('room'),
    code: input.roomCode,
    name: input.roomName.trim() || content.title,
    hostPlayerId,
    status: 'lobby',
    contentId: content.id,
    roundNumber: 1,
    currentTeamId: teams[0]?.id,
    createdAtMs: input.nowMs,
    updatedAtMs: input.nowMs,
    players: [hostPlayer],
    teams,
  }

  return {
    room,
    content,
    state: {
      state: 'RoomLobby',
      room,
      readyAtMs: input.nowMs,
    } satisfies RoomLobbyState,
    hostToken,
    playersById,
    playersByToken,
    clueById,
    finalClueState,
    finalWagersByTeamId: {},
    finalAnswersByTeamId: {},
    doubleDownWagersByClueId: {},
    kickedPlayerIds: new Set(),
  }
}

export function createSnapshot(runtime: EngineRuntime, nowMs: number): Snapshot<FsmState> & {
  selectedPlayerId?: string
  selectedClueId?: string
  activePlayer?: Player
  joinUrl?: string
  hostJoinUrl?: string
} {
  const room = cloneRoom(runtime.room, Array.from(runtime.playersById.values()), nowMs)
  const state = cloneState(runtime)
  const selectedClueId = getSelectedClueId(state)
  const selectedPlayerId = getSelectedPlayerId(state)
  return {
    room,
    content: runtime.content,
    state,
    generatedAtMs: nowMs,
    selectedPlayerId,
    selectedClueId,
    activePlayer: selectedPlayerId ? room.players.find((player) => player.id === selectedPlayerId) : undefined,
  }
}

export function createBoardSnapshot(runtime: EngineRuntime, nowMs: number) {
  return createSnapshot(runtime, nowMs)
}

export function heartbeat(runtime: EngineRuntime, playerToken: string | undefined, nowMs: number): EngineRuntime {
  if (!playerToken) return runtime
  const playerId = runtime.playersByToken.get(playerToken)
  if (!playerId) return runtime
  const player = runtime.playersById.get(playerId)
  if (!player) return runtime
  player.lastSeenAtMs = nowMs
  player.connected = true
  return syncRuntime(runtime, nowMs)
}

export function joinPlayer(runtime: EngineRuntime, displayName: string, teamId: string | undefined, nowMs: number): MutationResult {
  const activePlayers = getActivePlayerCount(runtime)
  const roomIsActive = runtime.room.status === 'active'
  if (!roomIsActive && activePlayers >= MAX_PLAYERS) {
    throw createEngineError('room_full', 'The room already has the maximum number of active players.', false)
  }

  const spectator = roomIsActive || activePlayers >= MAX_PLAYERS
  const resolvedTeamId = spectator ? SPECTATOR_TEAM_ID : resolveJoinTeamId(runtime, teamId, displayName)
  const playerId = createId('player')
  const playerToken = createToken()
  const player: RuntimePlayer = {
    id: playerId,
    displayName: displayName.trim() || 'Player',
    teamId: resolvedTeamId,
    isHost: false,
    connected: true,
    token: playerToken,
    joinedAtMs: nowMs,
    lastSeenAtMs: nowMs,
    mutedUntilMs: undefined,
    spectator,
  }
  runtime.playersById.set(playerId, player)
  runtime.playersByToken.set(playerToken, playerId)
  if (!spectator) {
    maybeBalanceTeams(runtime)
  }
  runtime.room.hostPlayerId = runtime.room.hostPlayerId || playerId
  runtime.room = syncRuntime(runtime, nowMs).room
  return { runtime, player, session: { playerId, playerToken } }
}

export function rejoinPlayer(
  runtime: EngineRuntime,
  displayName: string,
  playerToken: string,
  nowMs: number,
): MutationResult {
  const playerId = runtime.playersByToken.get(playerToken)
  if (!playerId) {
    throw createEngineError('invalid_token', 'The player token is not recognized.', false)
  }
  const player = runtime.playersById.get(playerId)
  if (!player || runtime.kickedPlayerIds.has(playerId)) {
    throw createEngineError('kicked', 'That player was removed from the room.', false)
  }
  player.displayName = displayName.trim() || player.displayName
  player.connected = true
  player.lastSeenAtMs = nowMs
  player.spectator = player.teamId === SPECTATOR_TEAM_ID
  runtime.room = syncRuntime(runtime, nowMs).room
  return { runtime, player, session: { playerId, playerToken } }
}

export function pauseRoom(runtime: EngineRuntime, nowMs: number): EngineRuntime {
  if (runtime.room.status !== 'active') return runtime
  runtime.pausedAtMs = nowMs
  runtime.room.status = 'paused'
  return syncRuntime(runtime, nowMs)
}

export function resumeRoom(runtime: EngineRuntime, nowMs: number): EngineRuntime {
  if (runtime.room.status === 'paused' && runtime.pausedAtMs) {
    const pauseDuration = nowMs - runtime.pausedAtMs
    shiftDeadlines(runtime, pauseDuration)
    runtime.pausedAtMs = undefined
    runtime.room.status = runtime.state.state === 'GameOver' ? 'complete' : 'active'
    return syncRuntime(runtime, nowMs)
  }
  if (runtime.room.status === 'lobby' && runtime.state.state === 'RoomLobby') {
    runtime.room.status = 'active'
    runtime.room.currentTeamId = getOpeningControlTeamId(runtime, 1)
    runtime.state = {
      state: 'RoundIntro',
      room: runtime.room,
      roundNumber: 1,
      headline: 'Round 1 is live',
      endsAtMs: nowMs + ROUND_INTRO_MS,
    } satisfies RoundIntroState
    runtime.room.roundNumber = 1
    return syncRuntime(runtime, nowMs)
  }
  return runtime
}

export function resetRoom(runtime: EngineRuntime, nowMs: number, hardReset = true): EngineRuntime {
  void hardReset
  const room = runtime.room
  const teams = createTeams()
  const players = Array.from(runtime.playersById.values()).filter((player) => !runtime.kickedPlayerIds.has(player.id))
  const nextPlayers = new Map<string, RuntimePlayer>()
  const nextTokens = new Map<string, string>()
  for (const player of players) {
    const nextPlayer = {
      ...player,
      teamId: player.isHost ? teams[0].id : resolveJoinTeamIdFromList(teams, player.teamId),
      connected: true,
      spectator: false,
      mutedUntilMs: undefined,
    }
    nextPlayers.set(nextPlayer.id, nextPlayer)
    nextTokens.set(nextPlayer.token, nextPlayer.id)
  }
  const hostPlayer = nextPlayers.get(room.hostPlayerId) ?? players[0]
  const hostPlayerId = hostPlayer?.id ?? createId('player')
  const hostToken = hostPlayer?.token ?? createToken()
  const normalizedHost = hostPlayer
    ? {
        ...hostPlayer,
        id: hostPlayerId,
        token: hostToken,
        isHost: true,
        teamId: teams[0].id,
      }
    : {
        id: hostPlayerId,
        displayName: 'Host',
        teamId: teams[0].id,
        isHost: true,
        connected: true,
        token: hostToken,
        joinedAtMs: nowMs,
        lastSeenAtMs: nowMs,
        spectator: false,
      }
  nextPlayers.set(hostPlayerId, normalizedHost)
  nextTokens.set(hostToken, hostPlayerId)
  const newRoom: Room = {
    ...room,
    status: 'lobby',
    roundNumber: 1,
    currentClueId: undefined,
    currentTeamId: teams[0].id,
    updatedAtMs: nowMs,
    players: Array.from(nextPlayers.values()),
    teams,
  }
  runtime.room = newRoom
  runtime.hostToken = hostToken
  runtime.playersById = nextPlayers
  runtime.playersByToken = nextTokens
  runtime.clueById = buildClueMap(runtime.content.boardCategories)
  runtime.finalClueState = buildFinalClueState(runtime.content.finalClue)
  runtime.finalWagersByTeamId = {}
  runtime.finalAnswersByTeamId = {}
  runtime.doubleDownWagersByClueId = {}
  runtime.pendingJudgment = undefined
  runtime.adjudicationDueAtMs = undefined
  runtime.resolutionReadyAtMs = undefined
  runtime.doubleDownWagerDueAtMs = undefined
  runtime.pausedAtMs = undefined
  runtime.kickedPlayerIds = new Set()
  runtime.state = {
    state: 'RoomLobby',
    room: newRoom,
    readyAtMs: nowMs,
  } satisfies RoomLobbyState
  return syncRuntime(runtime, nowMs)
}

export function kickPlayer(runtime: EngineRuntime, playerId: string, nowMs: number): EngineRuntime {
  const player = runtime.playersById.get(playerId)
  if (!player) {
    throw createEngineError('player_not_found', 'The player does not exist in this room.', false)
  }
  runtime.kickedPlayerIds.add(playerId)
  runtime.playersById.delete(playerId)
  runtime.playersByToken.delete(player.token)
  if (runtime.room.hostPlayerId === playerId) {
    const nextHost = Array.from(runtime.playersById.values())[0]
    if (nextHost) {
      nextHost.isHost = true
      runtime.room.hostPlayerId = nextHost.id
      runtime.hostToken = nextHost.token
    }
  }
  runtime.room = syncRuntime(runtime, nowMs).room
  return runtime
}

export function selectClue(runtime: EngineRuntime, playerId: string, clueId: string, nowMs: number): EngineRuntime {
  if (runtime.room.status !== 'active') {
    throw createEngineError('room_not_active', 'The room is not active yet.', true)
  }
  if (runtime.state.state !== 'BoardIdle') {
    throw createEngineError('clue_unavailable', 'A clue is already in progress.', true)
  }
  const player = requirePlayer(runtime, playerId)
  if (!canControlBoard(runtime, player)) {
    throw createEngineError('forbidden', 'That player cannot select the board right now.', false)
  }
  const clue = runtime.clueById.get(clueId)
  if (!clue || clue.status !== 'available') {
    throw createEngineError('clue_unavailable', 'That clue is not available.', true)
  }
  if ((clue.round ?? runtime.room.roundNumber) !== runtime.room.roundNumber) {
    throw createEngineError('clue_unavailable', 'That clue is not available in this round.', true)
  }
  clue.status = 'selected'
  clue.selectedByPlayerId = playerId
  runtime.room.currentClueId = clueId
  runtime.room.currentTeamId = player.teamId
  if (shouldDoubleDown(clue)) {
    runtime.doubleDownWagerDueAtMs = nowMs + WAGER_WINDOW_MS
    runtime.state = {
      state: 'DoubleDownWager',
      room: runtime.room,
      clueId,
      teamId: player.teamId,
      minimumWager: DOUBLE_DOWN_WAGER_MIN,
      maximumWager: calculateDoubleDownMaximum(runtime, player.teamId, clue.value),
    } satisfies DoubleDownWagerState
    return syncRuntime(runtime, nowMs)
  }
  clue.status = 'reading'
  runtime.state = {
    state: 'ClueReading',
    room: runtime.room,
    clue,
    startedAtMs: nowMs,
    endsAtMs: nowMs + CLUE_READING_MS,
  } satisfies ClueReadingState
  return syncRuntime(runtime, nowMs)
}

export function submitBuzz(runtime: EngineRuntime, playerId: string, clueId: string | undefined, nowMs: number): EngineRuntime {
  if (runtime.state.state !== 'BuzzWindow') {
    throw createEngineError('buzz_closed', 'Buzzing is not open right now.', true)
  }
  const player = requirePlayer(runtime, playerId)
  if (player.spectator) {
    throw createEngineError('spectator', 'Spectators cannot buzz.', false)
  }
  if (player.mutedUntilMs && nowMs < player.mutedUntilMs) {
    throw createEngineError('lockout', 'That player is locked out for this clue.', true)
  }
  if (clueId && clueId !== runtime.state.clueId) {
    throw createEngineError('clue_mismatch', 'That buzz references a different clue.', false)
  }
  const existingWinner = runtime.state.buzzedByPlayerId
  if (existingWinner) {
    throw createEngineError('buzz_taken', 'Another player already won the buzz.', true)
  }
  runtime.state = {
    state: 'TeamAnswering',
    room: runtime.room,
    clueId: runtime.state.clueId,
    teamId: player.teamId,
    answerStartedAtMs: nowMs,
    answerDueAtMs: nowMs + ANSWER_WINDOW_MS,
  } satisfies TeamAnsweringState
  runtime.room.currentTeamId = player.teamId
  runtime.room.currentClueId = runtime.state.clueId
  return syncRuntime(runtime, nowMs)
}

export function submitAnswerChoice(
  runtime: EngineRuntime,
  playerId: string,
  clueId: string | undefined,
  choiceId: string,
  nowMs: number,
): EngineRuntime {
  if (runtime.state.state !== 'TeamAnswering') {
    throw createEngineError('not_answering', 'There is no team answer pending.', true)
  }
  const player = requirePlayer(runtime, playerId)
  const clue = runtime.clueById.get(runtime.state.clueId)
  if (!clue) {
    throw createEngineError('clue_not_found', 'The current clue was not found.', false)
  }
  if (clueId && clueId !== runtime.state.clueId) {
    throw createEngineError('clue_mismatch', 'That answer references a different clue.', false)
  }
  if (player.teamId !== runtime.state.teamId) {
    throw createEngineError('wrong_team', 'That player is not the answering team.', false)
  }
  const result = judgeChoice(clue, choiceId)
  runtime.pendingJudgment = {
    clueId: runtime.state.clueId,
    teamId: runtime.state.teamId,
    answerId: choiceId,
    answerText: choiceId,
    submittedAtMs: nowMs,
    buzzedByPlayerId: playerId,
    correct: result.correct,
    scoreDelta: result.scoreDelta,
    result: result.result,
  }
  runtime.adjudicationDueAtMs = nowMs + ADJUDICATION_MS
  runtime.state = {
    state: 'Adjudication',
    room: runtime.room,
    clueId: runtime.state.clueId,
    teamId: runtime.state.teamId,
    answerId: choiceId,
    buzzedByPlayerId: playerId,
    hostOverridePending: true,
  } satisfies AdjudicationState
  return syncRuntime(runtime, nowMs)
}

export function submitWager(runtime: EngineRuntime, playerId: string, wager: number, nowMs: number): EngineRuntime {
  if (runtime.state.state !== 'DoubleDownWager' && runtime.state.state !== 'FinalWagering') {
    throw createEngineError('not_wagering', 'The room is not collecting wagers.', true)
  }
  const player = requirePlayer(runtime, playerId)
  const teamId = player.teamId
  if (teamId === SPECTATOR_TEAM_ID) {
    throw createEngineError('spectator', 'Spectators cannot wager.', false)
  }
  if (runtime.state.state === 'DoubleDownWager') {
    if (teamId !== runtime.state.teamId) {
      throw createEngineError('wrong_team', 'That team does not control the wager clue.', false)
    }
    const clue = runtime.clueById.get(runtime.state.clueId)
    if (!clue) {
      throw createEngineError('clue_not_found', 'The wager clue was not found.', false)
    }
    const nextWager = clamp(wager, runtime.state.minimumWager, runtime.state.maximumWager)
    runtime.doubleDownWagersByClueId[clue.id] = nextWager
    clue.wager = nextWager
    clue.status = 'reading'
    runtime.state = {
      state: 'ClueReading',
      room: runtime.room,
      clue,
      startedAtMs: nowMs,
      endsAtMs: nowMs + CLUE_READING_MS,
    } satisfies ClueReadingState
    runtime.doubleDownWagerDueAtMs = undefined
    return syncRuntime(runtime, nowMs)
  }
  const team = requireTeam(runtime, teamId)
  const maxWager = Math.max(FINAL_WAGER_MIN, Math.min(FINAL_WAGER_MAX, Math.max(0, team.score)))
  const nextWager = clamp(wager, FINAL_WAGER_MIN, maxWager)
  runtime.finalWagersByTeamId[teamId] = nextWager
  runtime.finalClueState.wagerByTeamId = { ...runtime.finalClueState.wagerByTeamId, [teamId]: nextWager }
  runtime.room.teams = runtime.room.teams.map((entry) => (entry.id === teamId ? { ...entry, wager: nextWager } : entry))
  runtime.room.updatedAtMs = nowMs
  return syncRuntime(runtime, nowMs)
}

export function submitFinalAnswer(runtime: EngineRuntime, playerId: string, choiceId: string, nowMs: number): EngineRuntime {
  if (runtime.state.state !== 'FinalAnswering') {
    throw createEngineError('not_final_answering', 'The final answer window is closed.', true)
  }
  const player = requirePlayer(runtime, playerId)
  const teamId = player.teamId
  const wager = runtime.finalWagersByTeamId[teamId]
  if (teamId === SPECTATOR_TEAM_ID) {
    throw createEngineError('spectator', 'Spectators cannot answer the final clue.', false)
  }
  if (wager === undefined) {
    throw createEngineError('no_wager', 'That team has not locked a wager yet.', true)
  }
  runtime.finalAnswersByTeamId[teamId] = choiceId
  runtime.finalClueState.answerByTeamId = { ...runtime.finalClueState.answerByTeamId, [teamId]: choiceId }
  runtime.room.teams = runtime.room.teams.map((entry) =>
    entry.id === teamId ? { ...entry, finalAnswerId: choiceId, finalAnswerText: choiceId } : entry,
  )
  runtime.room.updatedAtMs = nowMs
  return syncRuntime(runtime, nowMs)
}

export function hostFinalOverride(
  runtime: EngineRuntime,
  input: { teamId?: string; wager?: number; answerId?: string; correct?: boolean },
  nowMs: number,
): EngineRuntime {
  const teamId = input.teamId
  if (!teamId) return runtime
  const team = requireTeam(runtime, teamId)
  const wager = input.wager ?? runtime.finalWagersByTeamId[teamId] ?? 0
  if (runtime.state.state === 'Adjudication' && runtime.pendingJudgment?.teamId === teamId) {
    const delta = input.correct === false ? -Math.abs(wager) : Math.abs(wager)
    finalizeBoardJudgment(runtime, {
      ...runtime.pendingJudgment,
      answerId: input.answerId ?? runtime.pendingJudgment.answerId,
      correct: input.correct ?? runtime.pendingJudgment.correct,
      scoreDelta: delta,
      result: input.correct === false ? 'incorrect' : 'correct',
    }, nowMs)
    return runtime
  }
  if (runtime.state.state !== 'FinalReveal' && runtime.state.state !== 'FinalAnswering') {
    throw createEngineError('not_final', 'Final override is only allowed during the final clue.', false)
  }
  const correct = input.correct ?? false
  const delta = correct ? Math.abs(wager) : -Math.abs(wager)
  team.score += delta
  if (input.answerId) {
    team.finalAnswerId = input.answerId
    team.finalAnswerText = input.answerId
  }
  runtime.finalClueState.answerByTeamId = { ...runtime.finalClueState.answerByTeamId, [teamId]: input.answerId ?? team.finalAnswerId ?? '' }
  runtime.room.updatedAtMs = nowMs
  return syncRuntime(runtime, nowMs)
}

export function continueRoom(runtime: EngineRuntime, nowMs: number): EngineRuntime {
  if (runtime.state.state === 'RoomLobby') {
    return resumeRoom(runtime, nowMs)
  }
  return runtime
}

export function advanceRuntime(runtime: EngineRuntime, nowMs: number): EngineRuntime {
  if (runtime.room.status === 'paused') {
    return runtime
  }
  let progressed = true
  while (progressed) {
    progressed = false
    switch (runtime.state.state) {
      case 'RoundIntro':
        if (nowMs >= runtime.state.endsAtMs) {
          enterBoardIdle(runtime, nowMs)
          progressed = true
        }
        break
      case 'ClueReading':
        if (nowMs >= runtime.state.endsAtMs) {
          const clue = runtime.clueById.get(runtime.state.clue.id)!
          if (clue.wager) {
            clue.status = 'answering'
            const selectingPlayer = clue.selectedByPlayerId ? runtime.playersById.get(clue.selectedByPlayerId) : undefined
            runtime.state = {
              state: 'TeamAnswering',
              room: runtime.room,
              clueId: runtime.state.clue.id,
              teamId: selectingPlayer?.teamId ?? runtime.room.currentTeamId ?? runtime.room.teams[0].id,
              answerStartedAtMs: nowMs,
              answerDueAtMs: nowMs + ANSWER_WINDOW_MS,
            } satisfies TeamAnsweringState
          } else {
            const openAtMs = runtime.state.endsAtMs
            clue.status = 'buzzing'
            runtime.state = {
              state: 'BuzzWindow',
              room: runtime.room,
              clueId: runtime.state.clue.id,
              openAtMs,
              closesAtMs: openAtMs + BUZZ_WINDOW_MS,
            } satisfies BuzzWindowState
          }
          progressed = true
        }
        break
      case 'BuzzWindow':
        if (nowMs >= runtime.state.closesAtMs) {
          finalizeBoardJudgment(
            runtime,
            {
              clueId: runtime.state.clueId,
              teamId: runtime.room.currentTeamId ?? runtime.room.teams[0].id,
              answerId: 'timeout',
              answerText: 'timeout',
              submittedAtMs: nowMs,
              correct: false,
              scoreDelta: 0,
              result: 'timeout',
            },
            nowMs,
          )
          progressed = true
        }
        break
      case 'TeamAnswering':
        if (nowMs >= runtime.state.answerDueAtMs) {
          finalizeBoardJudgment(
            runtime,
            {
              clueId: runtime.state.clueId,
              teamId: runtime.state.teamId,
              answerId: 'timeout',
              answerText: 'timeout',
              submittedAtMs: nowMs,
              correct: false,
              scoreDelta: 0,
              result: 'timeout',
            },
            nowMs,
          )
          progressed = true
        }
        break
      case 'Adjudication':
        if (nowMs >= (runtime.adjudicationDueAtMs ?? nowMs)) {
          finalizePendingJudgment(runtime, nowMs)
          progressed = true
        }
        break
      case 'ClueResolution':
        if (nowMs >= (runtime.resolutionReadyAtMs ?? nowMs)) {
          afterBoardResolution(runtime, nowMs)
          progressed = true
        }
        break
      case 'DoubleDownWager':
        if (nowMs >= (runtime.doubleDownWagerDueAtMs ?? nowMs)) {
          finalizeBoardJudgment(
            runtime,
            {
              clueId: runtime.state.clueId,
              teamId: runtime.state.teamId,
              answerId: 'forfeit',
              answerText: 'forfeit',
              submittedAtMs: nowMs,
              correct: false,
              scoreDelta: 0,
              result: 'forfeit',
            },
            nowMs,
          )
          progressed = true
        }
        break
      case 'RoundTransition':
        if (nowMs >= runtime.state.endsAtMs) {
          if (runtime.state.fromRoundNumber === 1 && hasAvailableCluesForRound(runtime, 2)) {
            enterNextRound(runtime, runtime.state.endsAtMs)
          } else {
            enterFinalIntro(runtime, runtime.state.endsAtMs)
          }
          progressed = true
        }
        break
      case 'FinalIntro':
        if (nowMs >= runtime.state.startsAtMs + FINAL_INTRO_MS) {
          enterFinalWagering(runtime, runtime.state.startsAtMs + FINAL_INTRO_MS)
          progressed = true
        }
        break
      case 'FinalWagering':
        if (nowMs >= runtime.state.wagerDueAtMs) {
          enterFinalAnswering(runtime, runtime.state.wagerDueAtMs)
          progressed = true
        }
        break
      case 'FinalAnswering':
        if (nowMs >= runtime.state.answerDueAtMs) {
          enterFinalReveal(runtime, runtime.state.answerDueAtMs)
          progressed = true
        }
        break
      case 'FinalReveal':
        if (nowMs >= runtime.state.revealedAtMs + FINAL_REVEAL_MS) {
          enterGameOver(runtime, runtime.state.revealedAtMs + FINAL_REVEAL_MS)
          progressed = true
        }
        break
      default:
        break
    }
  }
  return syncRuntime(runtime, nowMs)
}

export function getDeadline(state: FsmState): { eventName: 'player/selectClue' | 'player/buzz' | 'player/answerChoice' | 'player/submitWager' | 'player/submitFinalAnswer' | 'player/continue'; startsAtMs: number; endsAtMs: number } | null {
  switch (state.state) {
    case 'ClueReading':
      return { eventName: 'player/buzz', startsAtMs: state.startedAtMs, endsAtMs: state.endsAtMs }
    case 'BuzzWindow':
      return { eventName: 'player/buzz', startsAtMs: state.openAtMs, endsAtMs: state.closesAtMs }
    case 'TeamAnswering':
      return { eventName: 'player/answerChoice', startsAtMs: state.answerStartedAtMs, endsAtMs: state.answerDueAtMs }
    case 'DoubleDownWager':
      return {
        eventName: 'player/submitWager',
        startsAtMs: state.room.updatedAtMs,
        endsAtMs: state.room.updatedAtMs + WAGER_WINDOW_MS,
      }
    case 'FinalWagering':
      return {
        eventName: 'player/submitWager',
        startsAtMs: state.room.updatedAtMs,
        endsAtMs: state.wagerDueAtMs,
      }
    case 'FinalAnswering':
      return {
        eventName: 'player/submitFinalAnswer',
        startsAtMs: state.room.updatedAtMs,
        endsAtMs: state.answerDueAtMs,
      }
    case 'RoundTransition':
      return {
        eventName: 'player/continue',
        startsAtMs: state.room.updatedAtMs,
        endsAtMs: state.endsAtMs,
      }
    default:
      return null
  }
}

function finalizePendingJudgment(runtime: EngineRuntime, nowMs: number): void {
  const pending = runtime.pendingJudgment
  if (!pending) return
  finalizeBoardJudgment(runtime, pending, nowMs)
}

function finalizeBoardJudgment(runtime: EngineRuntime, judgment: PendingJudgment, nowMs: number): void {
  const clue = runtime.clueById.get(judgment.clueId)
  if (!clue) {
    throw createEngineError('clue_not_found', 'The current clue was not found.', false)
  }
  const team = requireTeam(runtime, judgment.teamId)
  const scoreDelta = judgment.correct ? Math.abs(judgment.scoreDelta ?? clue.value) : -Math.abs(judgment.scoreDelta ?? clue.value)
  team.score += scoreDelta
  runtime.room.currentTeamId = judgment.correct ? team.id : getOpposingTeamId(runtime, team.id)
  if (judgment.result === 'timeout' || judgment.result === 'forfeit') {
    applyReboundLockout(runtime, team.id, nowMs)
  } else if (!judgment.correct) {
    applyReboundLockout(runtime, team.id, nowMs)
  }
  clue.status =
    judgment.correct ? 'resolved' : judgment.result === 'incorrect' ? 'available' : judgment.result === 'timeout' ? 'expired' : 'resolved'
  clue.answeredByTeamId = team.id
  clue.buzzedByPlayerId = judgment.buzzedByPlayerId
  runtime.pendingJudgment = undefined
  runtime.adjudicationDueAtMs = undefined
  runtime.resolutionReadyAtMs = nowMs + RESOLUTION_MS
  runtime.state = {
    state: 'ClueResolution',
    room: runtime.room,
    clueId: clue.id,
    result: judgment.correct ? 'correct' : judgment.result ?? 'incorrect',
    scoreDelta,
  } satisfies ClueResolutionState
  runtime.room.currentClueId = clue.id
  runtime.room.currentTeamId = team.id
  runtime.room.updatedAtMs = nowMs
  syncRuntime(runtime, nowMs)
}

function afterBoardResolution(runtime: EngineRuntime, nowMs: number): void {
  const clue = runtime.clueById.get(runtime.room.currentClueId ?? '')
  if (clue) {
    if (runtime.state.state === 'ClueResolution' && runtime.state.result === 'incorrect') {
      const reopenAtMs = runtime.resolutionReadyAtMs ?? nowMs
      clue.status = 'available'
      runtime.state = {
        state: 'BuzzWindow',
        room: runtime.room,
        clueId: clue.id,
        openAtMs: reopenAtMs,
        closesAtMs: reopenAtMs + BUZZ_WINDOW_MS,
        buzzedByPlayerId: runtime.pendingJudgment?.buzzedByPlayerId,
      } satisfies BuzzWindowState
      runtime.room.status = 'active'
      runtime.room.updatedAtMs = reopenAtMs
      syncRuntime(runtime, nowMs)
      return
    }
    clue.status = 'resolved'
  }
  runtime.room.currentClueId = undefined
  const nextClues = getAvailableCluesForRound(runtime)
  if (nextClues.length === 0) {
    enterRoundTransition(runtime, runtime.resolutionReadyAtMs ?? nowMs)
    return
  }
  const currentTeam = runtime.room.teams.find((team) => team.id === runtime.room.currentTeamId)
  if (!currentTeam) {
    runtime.room.currentTeamId = runtime.room.teams[0]?.id
  }
  runtime.state = {
    state: 'BoardIdle',
    room: runtime.room,
    roundNumber: runtime.room.roundNumber,
    availableClueIds: nextClues.map((entry) => entry.id),
  }
  runtime.room.status = 'active'
  runtime.room.updatedAtMs = nowMs
  syncRuntime(runtime, nowMs)
}

function enterBoardIdle(runtime: EngineRuntime, nowMs: number): void {
  const availableClueIds = getAvailableCluesForRound(runtime).map((clue) => clue.id)
  if (availableClueIds.length === 0) {
    enterRoundTransition(runtime, nowMs)
    return
  }
  runtime.state = {
    state: 'BoardIdle',
    room: runtime.room,
    roundNumber: runtime.room.roundNumber,
    availableClueIds,
    selectedClueId: undefined,
  }
  runtime.room.status = 'active'
  runtime.room.updatedAtMs = nowMs
  syncRuntime(runtime, nowMs)
}

function enterRoundTransition(runtime: EngineRuntime, nowMs: number): void {
  const toRoundNumber = runtime.room.roundNumber === 1 ? 2 : 2
  runtime.state = {
    state: 'RoundTransition',
    room: runtime.room,
    fromRoundNumber: runtime.room.roundNumber,
    toRoundNumber,
    endsAtMs: nowMs + ROUND_TRANSITION_MS,
  } satisfies RoundTransitionState
  runtime.room.status = 'active'
  runtime.room.updatedAtMs = nowMs
  syncRuntime(runtime, nowMs)
}

function enterNextRound(runtime: EngineRuntime, nowMs: number): void {
  runtime.room.roundNumber = 2
  runtime.room.currentTeamId = getOpeningControlTeamId(runtime, 2)
  runtime.room.currentClueId = undefined
  runtime.state = {
    state: 'RoundIntro',
    room: runtime.room,
    roundNumber: 2,
    headline: 'Round 2 is live',
    endsAtMs: nowMs + ROUND_INTRO_MS,
  } satisfies RoundIntroState
  runtime.room.status = 'active'
  runtime.room.updatedAtMs = nowMs
  syncRuntime(runtime, nowMs)
}

function enterFinalIntro(runtime: EngineRuntime, nowMs: number): void {
  runtime.finalClueState = {
    ...runtime.finalClueState,
    status: 'available',
    wagerByTeamId: {},
    answerByTeamId: {},
  }
  runtime.state = {
    state: 'FinalIntro',
    room: runtime.room,
    finalClue: runtime.finalClueState,
    startsAtMs: nowMs,
  } satisfies FinalIntroState
  runtime.room.status = 'active'
  runtime.room.updatedAtMs = nowMs
  syncRuntime(runtime, nowMs)
}

function enterFinalWagering(runtime: EngineRuntime, nowMs: number): void {
  runtime.finalWagersByTeamId = runtime.room.teams.reduce<Record<string, number>>((accumulator, team) => {
    accumulator[team.id] = runtime.finalWagersByTeamId[team.id] ?? 0
    return accumulator
  }, {})
  runtime.finalClueState = {
    ...runtime.finalClueState,
    status: 'locked',
    wagerByTeamId: { ...runtime.finalWagersByTeamId },
  }
  runtime.state = {
    state: 'FinalWagering',
    room: runtime.room,
    finalClueId: runtime.finalClueState.id,
    teams: runtime.room.teams,
    wagerDueAtMs: nowMs + WAGER_WINDOW_MS,
  } satisfies FinalWageringState
  runtime.room.status = 'active'
  runtime.room.updatedAtMs = nowMs
  syncRuntime(runtime, nowMs)
}

function enterFinalAnswering(runtime: EngineRuntime, nowMs: number): void {
  runtime.finalClueState = {
    ...runtime.finalClueState,
    status: 'answering',
    wagerByTeamId: { ...runtime.finalWagersByTeamId },
  }
  runtime.state = {
    state: 'FinalAnswering',
    room: runtime.room,
    finalClueId: runtime.finalClueState.id,
    answerDueAtMs: nowMs + ANSWER_WINDOW_MS,
    wagerByTeamId: { ...runtime.finalWagersByTeamId },
  } satisfies FinalAnsweringState
  runtime.room.status = 'active'
  runtime.room.updatedAtMs = nowMs
  syncRuntime(runtime, nowMs)
}

function enterFinalReveal(runtime: EngineRuntime, nowMs: number): void {
  const finalClue = runtime.finalClueState
  const resultByTeamId = resolveFinalScores(runtime)
  runtime.room.teams = runtime.room.teams.map((team) => ({ ...team, score: resultByTeamId[team.id] ?? team.score }))
  runtime.finalClueState = {
    ...finalClue,
    status: 'resolved',
    wagerByTeamId: { ...runtime.finalWagersByTeamId },
    answerByTeamId: { ...runtime.finalAnswersByTeamId },
  }
  runtime.state = {
    state: 'FinalReveal',
    room: runtime.room,
    finalClue: runtime.finalClueState,
    revealedAtMs: nowMs,
  } satisfies FinalRevealState
  runtime.room.status = 'active'
  runtime.room.updatedAtMs = nowMs
  syncRuntime(runtime, nowMs)
}

function enterGameOver(runtime: EngineRuntime, nowMs: number): void {
  const scores = Object.fromEntries(runtime.room.teams.map((team) => [team.id, team.score])) as Readonly<Record<string, number>>
  const winnerTeamId = runtime.room.teams.slice().sort((left, right) => right.score - left.score)[0]?.id
  runtime.state = {
    state: 'GameOver',
    room: runtime.room,
    finalScores: scores,
    winnerTeamId,
    endedAtMs: nowMs,
  } satisfies GameOverState
  runtime.room.status = 'complete'
  runtime.room.updatedAtMs = nowMs
  syncRuntime(runtime, nowMs)
}

function resolveFinalScores(runtime: EngineRuntime): Record<string, number> {
  const result: Record<string, number> = {}
  for (const team of runtime.room.teams) {
    const wager = runtime.finalWagersByTeamId[team.id] ?? 0
    const answer = runtime.finalAnswersByTeamId[team.id]
    const correct = answer ? isFinalAnswerCorrect(runtime.finalClueState, answer) : false
    result[team.id] = team.score + (correct ? wager : -wager)
  }
  return result
}

export function isFinalAnswerCorrect(finalClue: FinalClueState, answer: string): boolean {
  const normalizedAnswer = normalizeFinalAnswer(answer)
  const aliases = [finalClue.correctAnswerId]
  if (finalClue.correctAnswer) aliases.push(finalClue.correctAnswer)
  if (finalClue.aliases) aliases.push(...finalClue.aliases)
  return aliases.some((alias) => editDistance(normalizeFinalAnswer(alias), normalizedAnswer) <= 2)
}

function buildClueMap(categories: readonly BoardCategory[]): Map<string, BoardClueState> {
  const clueMap = new Map<string, BoardClueState>()
  for (const category of categories) {
    for (const clue of category.clues) {
      clueMap.set(clue.id, {
        ...clue,
        status: 'available',
      })
    }
  }
  return clueMap
}

function buildFinalClueState(finalClue: FinalClue): FinalClueState {
  return {
    ...finalClue,
    status: 'locked',
    wagerByTeamId: {},
    answerByTeamId: {},
  }
}

function getAvailableCluesForRound(runtime: EngineRuntime): BoardClueState[] {
  const hasExplicitRounds = Array.from(runtime.clueById.values()).some((entry) => entry.round === 1 || entry.round === 2)
  return Array.from(runtime.clueById.values()).filter(
    (entry) => entry.status === 'available' && (!hasExplicitRounds || entry.round === runtime.room.roundNumber),
  )
}

function hasAvailableCluesForRound(runtime: EngineRuntime, roundNumber: number): boolean {
  return Array.from(runtime.clueById.values()).some((entry) => entry.status === 'available' && entry.round === roundNumber)
}

function resolveJoinTeamId(runtime: EngineRuntime, preferredTeamId: string | undefined, displayName: string): string {
  if (preferredTeamId && runtime.room.teams.some((team) => team.id === preferredTeamId)) {
    return preferredTeamId
  }
  const nextIndex = runtime.room.teams.length + 1
  const team: Team = {
    id: `team-${nextIndex}`,
    name: displayName.trim() || `Team ${nextIndex}`,
    color: TEAM_COLORS[(nextIndex - 1) % TEAM_COLORS.length] ?? '#38bdf8',
    score: 0,
  }
  runtime.room.teams = [...runtime.room.teams, team]
  return team.id
}

function resolveJoinTeamIdFromList(teams: readonly Team[], preferredTeamId: string): string {
  return teams.some((team) => team.id === preferredTeamId) ? preferredTeamId : teams[0].id
}

function createTeams(): Team[] {
  return [
    { id: 'team-1', name: 'Host', color: TEAM_COLORS[0], score: 0 },
  ]
}

function maybeBalanceTeams(runtime: EngineRuntime): void {
  void runtime
}

function requirePlayer(runtime: EngineRuntime, playerId: string): RuntimePlayer {
  const player = runtime.playersById.get(playerId)
  if (!player) {
    throw createEngineError('player_not_found', 'The player does not exist in this room.', false)
  }
  return player
}

function requireTeam(runtime: EngineRuntime, teamId: string): Team {
  const team = runtime.room.teams.find((entry) => entry.id === teamId)
  if (!team) {
    throw createEngineError('team_not_found', 'The team does not exist in this room.', false)
  }
  return team
}

function getOpposingTeamId(runtime: EngineRuntime, teamId: string): string {
  const playableTeamIds = getPlayableTeamIds(runtime)
  const opposing = runtime.room.teams.find((entry) => entry.id !== teamId && playableTeamIds.includes(entry.id))
  return opposing?.id ?? teamId
}

function getOpeningControlTeamId(runtime: EngineRuntime, roundNumber: number): string | undefined {
  const playableTeamIds = getPlayableTeamIds(runtime)
  const playableTeams = runtime.room.teams.filter((team) => playableTeamIds.includes(team.id))
  if (!playableTeams.length) return runtime.room.currentTeamId ?? runtime.room.teams[0]?.id
  if (roundNumber === 2) {
    return playableTeams.slice().sort((left, right) => left.score - right.score || left.name.localeCompare(right.name))[0]?.id
  }
  return playableTeams[0]?.id
}

function getPlayableTeamIds(runtime: EngineRuntime): string[] {
  const ids = new Set<string>()
  for (const player of runtime.playersById.values()) {
    if (!player.isHost && !player.spectator && player.teamId !== SPECTATOR_TEAM_ID) {
      ids.add(player.teamId)
    }
  }
  return Array.from(ids)
}

function canControlBoard(runtime: EngineRuntime, player: RuntimePlayer): boolean {
  if (player.isHost) return true
  return player.teamId !== SPECTATOR_TEAM_ID && runtime.room.currentTeamId === player.teamId
}

function shouldDoubleDown(clue: BoardClueState): boolean {
  return Boolean(clue.doubleDown)
}

function calculateDoubleDownMaximum(runtime: EngineRuntime, teamId: string, clueValue: number): number {
  const team = runtime.room.teams.find((entry) => entry.id === teamId)
  const bank = team ? Math.max(0, team.score) : 0
  const roundCap = runtime.room.roundNumber === 2 ? DOUBLE_DOWN_ROUND_TWO_CAP : DOUBLE_DOWN_ROUND_ONE_CAP
  return Math.min(DOUBLE_DOWN_WAGER_MAX, Math.max(roundCap, bank, clueValue, DOUBLE_DOWN_WAGER_MIN))
}

function judgeChoice(
  clue: BoardClueState,
  choiceId: string,
): { correct: boolean; scoreDelta: number; result: 'correct' | 'incorrect' } {
  const correct = normalizeFinalAnswer(choiceId) === normalizeFinalAnswer(clue.correctAnswerId)
  return {
    correct,
    scoreDelta: correct ? clue.wager ?? clue.value : -(clue.wager ?? clue.value),
    result: correct ? 'correct' : 'incorrect',
  }
}

function applyReboundLockout(runtime: EngineRuntime, teamId: string, nowMs: number): void {
  for (const player of runtime.playersById.values()) {
    if (player.teamId === teamId) {
      player.mutedUntilMs = nowMs + REBOUND_LOCKOUT_MS
    }
  }
}

function shiftDeadlines(runtime: EngineRuntime, deltaMs: number): void {
  if (runtime.state.state === 'RoundIntro') runtime.state = { ...runtime.state, endsAtMs: runtime.state.endsAtMs + deltaMs }
  if (runtime.state.state === 'ClueReading') runtime.state = { ...runtime.state, endsAtMs: runtime.state.endsAtMs + deltaMs, startedAtMs: runtime.state.startedAtMs + deltaMs }
  if (runtime.state.state === 'BuzzWindow') runtime.state = { ...runtime.state, openAtMs: runtime.state.openAtMs + deltaMs, closesAtMs: runtime.state.closesAtMs + deltaMs }
  if (runtime.state.state === 'TeamAnswering') runtime.state = { ...runtime.state, answerStartedAtMs: runtime.state.answerStartedAtMs + deltaMs, answerDueAtMs: runtime.state.answerDueAtMs + deltaMs }
  if (runtime.state.state === 'RoundTransition') runtime.state = { ...runtime.state, endsAtMs: runtime.state.endsAtMs + deltaMs }
  if (runtime.state.state === 'FinalIntro') runtime.state = { ...runtime.state, startsAtMs: runtime.state.startsAtMs + deltaMs }
  if (runtime.state.state === 'FinalWagering') runtime.state = { ...runtime.state, wagerDueAtMs: runtime.state.wagerDueAtMs + deltaMs }
  if (runtime.state.state === 'FinalAnswering') runtime.state = { ...runtime.state, answerDueAtMs: runtime.state.answerDueAtMs + deltaMs }
  if (runtime.state.state === 'FinalReveal') runtime.state = { ...runtime.state, revealedAtMs: runtime.state.revealedAtMs + deltaMs }
  if (runtime.adjudicationDueAtMs) runtime.adjudicationDueAtMs += deltaMs
  if (runtime.resolutionReadyAtMs) runtime.resolutionReadyAtMs += deltaMs
  if (runtime.doubleDownWagerDueAtMs) runtime.doubleDownWagerDueAtMs += deltaMs
  for (const player of runtime.playersById.values()) {
    if (player.mutedUntilMs) player.mutedUntilMs += deltaMs
    player.lastSeenAtMs += deltaMs
  }
}

function syncRuntime(runtime: EngineRuntime, nowMs: number): EngineRuntime {
  runtime.room.players = Array.from(runtime.playersById.values()).sort((left, right) => left.joinedAtMs - right.joinedAtMs)
  runtime.room.teams = runtime.room.teams.map((team) => {
    const source = runtime.room.teams.find((entry) => entry.id === team.id) ?? team
    const score = runtime.room.status === 'complete' || runtime.state.state === 'GameOver' ? (runtime.state.state === 'GameOver' ? runtime.state.finalScores[team.id] ?? team.score : team.score) : team.score
    return { ...source, score }
  })
  runtime.room.updatedAtMs = nowMs
  return runtime
}

function cloneRoom(room: Room, players: readonly RuntimePlayer[], nowMs: number): Room {
  return {
    ...room,
    updatedAtMs: nowMs,
    players: players.map((player) => ({ ...player })),
    teams: room.teams.map((team) => ({ ...team })),
  }
}

function cloneState(runtime: EngineRuntime): FsmState {
  const state = runtime.state
  switch (state.state) {
    case 'RoomLobby':
      return { ...state, room: cloneRoom(state.room, Array.from(runtime.playersById.values()), state.room.updatedAtMs) }
    case 'RoundIntro':
      return { ...state, room: cloneRoom(state.room, Array.from(runtime.playersById.values()), state.room.updatedAtMs) }
    case 'BoardIdle':
      return { ...state, room: cloneRoom(state.room, Array.from(runtime.playersById.values()), state.room.updatedAtMs) }
    case 'ClueReading':
      return { ...state, room: cloneRoom(state.room, Array.from(runtime.playersById.values()), state.room.updatedAtMs), clue: { ...state.clue } }
    case 'BuzzWindow':
      return { ...state, room: cloneRoom(state.room, Array.from(runtime.playersById.values()), state.room.updatedAtMs) }
    case 'TeamAnswering':
      return { ...state, room: cloneRoom(state.room, Array.from(runtime.playersById.values()), state.room.updatedAtMs) }
    case 'Adjudication':
      return { ...state, room: cloneRoom(state.room, Array.from(runtime.playersById.values()), state.room.updatedAtMs) }
    case 'ClueResolution':
      return { ...state, room: cloneRoom(state.room, Array.from(runtime.playersById.values()), state.room.updatedAtMs) }
    case 'DoubleDownWager':
      return { ...state, room: cloneRoom(state.room, Array.from(runtime.playersById.values()), state.room.updatedAtMs) }
    case 'RoundTransition':
      return { ...state, room: cloneRoom(state.room, Array.from(runtime.playersById.values()), state.room.updatedAtMs) }
    case 'FinalIntro':
      return { ...state, room: cloneRoom(state.room, Array.from(runtime.playersById.values()), state.room.updatedAtMs), finalClue: { ...state.finalClue } }
    case 'FinalWagering':
      return { ...state, room: cloneRoom(state.room, Array.from(runtime.playersById.values()), state.room.updatedAtMs), teams: state.teams.map((team) => ({ ...team })) }
    case 'FinalAnswering':
      return { ...state, room: cloneRoom(state.room, Array.from(runtime.playersById.values()), state.room.updatedAtMs) }
    case 'FinalReveal':
      return { ...state, room: cloneRoom(state.room, Array.from(runtime.playersById.values()), state.room.updatedAtMs), finalClue: { ...state.finalClue } }
    case 'GameOver':
      return { ...state, room: cloneRoom(state.room, Array.from(runtime.playersById.values()), state.room.updatedAtMs) }
  }
  return state
}

function getSelectedClueId(state: FsmState): string | undefined {
  if (state.state === 'ClueReading') return state.clue.id
  if (state.state === 'BuzzWindow') return state.clueId
  if (state.state === 'TeamAnswering') return state.clueId
  if (state.state === 'Adjudication') return state.clueId
  if (state.state === 'ClueResolution') return state.clueId
  if (state.state === 'DoubleDownWager') return state.clueId
  return undefined
}

function getSelectedPlayerId(state: FsmState): string | undefined {
  if (state.state === 'ClueReading') return state.clue.selectedByPlayerId
  if (state.state === 'BuzzWindow') return state.buzzedByPlayerId
  if (state.state === 'TeamAnswering') return undefined
  if (state.state === 'Adjudication') return state.buzzedByPlayerId
  return undefined
}

export function normalizeFinalAnswer(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\b(a|an|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function editDistance(left: string, right: string): number {
  const a = left
  const b = right
  const rows = a.length + 1
  const cols = b.length + 1
  const table: number[][] = Array.from({ length: rows }, () => Array(cols).fill(0))
  for (let i = 0; i < rows; i += 1) table[i]![0] = i
  for (let j = 0; j < cols; j += 1) table[0]![j] = j
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      table[i]![j] = Math.min(
        table[i - 1]![j]! + 1,
        table[i]![j - 1]! + 1,
        table[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
  }
  return table[rows - 1]![cols - 1]!
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function createId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`
}

function createToken(): string {
  return randomUUID().replace(/-/g, '')
}

function getActivePlayerCount(runtime: EngineRuntime): number {
  return Array.from(runtime.playersById.values()).filter((player) => !player.spectator).length
}
