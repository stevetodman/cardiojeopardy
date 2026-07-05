import type { FsmState } from './fsm'
import type { ContentDataset, Player, Room, Snapshot } from './types'

export const CLIENT_TO_SERVER_EVENT = {
  HOST_CREATE_ROOM: 'host/createRoom',
  HOST_PAUSE: 'host/pause',
  HOST_RESUME: 'host/resume',
  HOST_RESET_ROOM: 'host/resetRoom',
  HOST_KICK_PLAYER: 'host/kickPlayer',
  HOST_FINAL_OVERRIDE: 'host/finalOverride',
  PLAYER_JOIN: 'player/join',
  PLAYER_REJOIN: 'player/rejoin',
  PLAYER_SELECT_CLUE: 'player/selectClue',
  PLAYER_BUZZ: 'player/buzz',
  PLAYER_ANSWER_CHOICE: 'player/answerChoice',
  PLAYER_SUBMIT_WAGER: 'player/submitWager',
  PLAYER_SUBMIT_FINAL_ANSWER: 'player/submitFinalAnswer',
  PLAYER_CONTINUE: 'player/continue',
  CLIENT_HEARTBEAT: 'client/heartbeat',
} as const

export const SERVER_TO_CLIENT_EVENT = {
  ACK: 'server/ack',
  ERROR: 'server/error',
  SNAPSHOT: 'server/snapshot',
  ROOM_CREATED: 'server/roomCreated',
  PLAYER_TOKEN: 'server/playerToken',
  DEADLINE: 'server/deadline',
  KICKED: 'server/kicked',
} as const

export const FORBIDDEN_CLIENT_EVENT_NAMES = [
  'room/setScore',
  'room/setState',
  'room/updateSnapshot',
  'game/advanceState',
  'game/awardPoints',
  'game/resolveClue',
  'debug/forceSync',
] as const

export const HEARTBEAT_INTERVAL_MS = 10_000
export const HEARTBEAT_TIMEOUT_MS = 30_000
export const BUZZ_WINDOW_MS = 8_000
export const ANSWER_WINDOW_MS = 20_000
export const WAGER_WINDOW_MS = 20_000
export const ROUND_INTRO_MS = 5_000
export const ROUND_TRANSITION_MS = 4_000
export const FINAL_INTRO_MS = 6_000
export const FINAL_REVEAL_MS = 8_000
export const DOUBLE_DOWN_WAGER_MIN = 5
export const DOUBLE_DOWN_ROUND_ONE_CAP = 1000
export const DOUBLE_DOWN_ROUND_TWO_CAP = 2000
export const DOUBLE_DOWN_WAGER_MAX = 2000
export const FINAL_WAGER_MIN = 0
export const FINAL_WAGER_MAX = 1000

export type ClientToServerEventName =
  (typeof CLIENT_TO_SERVER_EVENT)[keyof typeof CLIENT_TO_SERVER_EVENT]

export type ServerToClientEventName =
  (typeof SERVER_TO_CLIENT_EVENT)[keyof typeof SERVER_TO_CLIENT_EVENT]

export type ForbiddenClientEventName = (typeof FORBIDDEN_CLIENT_EVENT_NAMES)[number]

export interface AckShape {
  requestId: string
  eventName: ClientToServerEventName
  acceptedAtMs: number
  message?: string
}

export interface ErrorShape {
  requestId?: string
  code: string
  message: string
  retryable: boolean
  details?: Readonly<Record<string, unknown>>
}

export interface DeadlineShape {
  deadlineId: string
  eventName:
    | 'host/createRoom'
    | 'host/pause'
    | 'host/resume'
    | 'host/resetRoom'
    | 'player/selectClue'
    | 'player/buzz'
    | 'player/answerChoice'
    | 'player/submitWager'
    | 'player/submitFinalAnswer'
    | 'player/continue'
  startsAtMs: number
  endsAtMs: number
}

export interface RoomSnapshotShape extends Snapshot<FsmState> {
  room: Room
  content: ContentDataset
  state: FsmState
  generatedAtMs: number
  selectedPlayerId?: string
  selectedClueId?: string
  activePlayer?: Player
  joinUrl?: string
  hostJoinUrl?: string
  playerJoinUrl?: string
}

export interface CreateRoomIntent {
  roomName: string
  hostName: string
  contentId?: string
  maxPlayers?: number
}

export interface HostPauseIntent {
  reason?: string
}

export interface HostResumeIntent {
  reason?: string
}

export interface HostResetRoomIntent {
  hardReset?: boolean
  note?: string
}

export interface HostKickPlayerIntent {
  playerId: string
  reason?: string
}

export interface HostFinalOverrideIntent {
  teamId?: string
  wager?: number
  answerId?: string
  correct?: boolean
  note?: string
}

export interface PlayerJoinIntent {
  roomCode: string
  displayName: string
  teamId?: string
}

export interface PlayerRejoinIntent {
  roomCode: string
  displayName: string
  playerToken: string
}

export interface PlayerSelectClueIntent {
  clueId: string
}

export interface PlayerBuzzIntent {
  clueId?: string
}

export interface PlayerAnswerChoiceIntent {
  clueId?: string
  choiceId: string
}

export interface PlayerSubmitWagerIntent {
  clueId?: string
  wager: number
}

export interface PlayerSubmitFinalAnswerIntent {
  finalClueId?: string
  choiceId: string
}

export interface PlayerContinueIntent {
  checkpointId?: string
}

export interface ClientHeartbeatIntent {
  sentAtMs: number
  roomCode?: string
  playerId?: string
  token?: string
}

export interface ClientToServerPayloadMap {
  [CLIENT_TO_SERVER_EVENT.HOST_CREATE_ROOM]: CreateRoomIntent
  [CLIENT_TO_SERVER_EVENT.HOST_PAUSE]: HostPauseIntent
  [CLIENT_TO_SERVER_EVENT.HOST_RESUME]: HostResumeIntent
  [CLIENT_TO_SERVER_EVENT.HOST_RESET_ROOM]: HostResetRoomIntent
  [CLIENT_TO_SERVER_EVENT.HOST_KICK_PLAYER]: HostKickPlayerIntent
  [CLIENT_TO_SERVER_EVENT.HOST_FINAL_OVERRIDE]: HostFinalOverrideIntent
  [CLIENT_TO_SERVER_EVENT.PLAYER_JOIN]: PlayerJoinIntent
  [CLIENT_TO_SERVER_EVENT.PLAYER_REJOIN]: PlayerRejoinIntent
  [CLIENT_TO_SERVER_EVENT.PLAYER_SELECT_CLUE]: PlayerSelectClueIntent
  [CLIENT_TO_SERVER_EVENT.PLAYER_BUZZ]: PlayerBuzzIntent
  [CLIENT_TO_SERVER_EVENT.PLAYER_ANSWER_CHOICE]: PlayerAnswerChoiceIntent
  [CLIENT_TO_SERVER_EVENT.PLAYER_SUBMIT_WAGER]: PlayerSubmitWagerIntent
  [CLIENT_TO_SERVER_EVENT.PLAYER_SUBMIT_FINAL_ANSWER]: PlayerSubmitFinalAnswerIntent
  [CLIENT_TO_SERVER_EVENT.PLAYER_CONTINUE]: PlayerContinueIntent
  [CLIENT_TO_SERVER_EVENT.CLIENT_HEARTBEAT]: ClientHeartbeatIntent
}

export interface ServerRoomCreatedPayload {
  roomId: string
  roomCode: string
  hostToken: string
  snapshot: RoomSnapshotShape
  joinUrl?: string
  hostJoinUrl?: string
  playerJoinUrl?: string
}

export interface ServerPlayerTokenPayload {
  playerId: string
  playerToken: string
}

export interface ServerKickedPayload {
  playerId: string
  roomCode: string
  reason: string
}

export interface ServerToClientPayloadMap {
  [SERVER_TO_CLIENT_EVENT.ACK]: AckShape
  [SERVER_TO_CLIENT_EVENT.ERROR]: ErrorShape
  [SERVER_TO_CLIENT_EVENT.SNAPSHOT]: RoomSnapshotShape
  [SERVER_TO_CLIENT_EVENT.ROOM_CREATED]: ServerRoomCreatedPayload
  [SERVER_TO_CLIENT_EVENT.PLAYER_TOKEN]: ServerPlayerTokenPayload
  [SERVER_TO_CLIENT_EVENT.DEADLINE]: DeadlineShape
  [SERVER_TO_CLIENT_EVENT.KICKED]: ServerKickedPayload
}

export interface ProtocolMessage<TName extends string, TPayload> {
  type: TName
  payload: TPayload
}

export type ClientToServerMessage = {
  [K in ClientToServerEventName]: ProtocolMessage<K, ClientToServerPayloadMap[K]>
}[ClientToServerEventName]

export type ServerToClientMessage = {
  [K in ServerToClientEventName]: ProtocolMessage<K, ServerToClientPayloadMap[K]>
}[ServerToClientEventName]
