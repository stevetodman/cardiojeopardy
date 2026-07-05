import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import './PlayerView.css'
import {
  CLIENT_TO_SERVER_EVENT,
  SERVER_TO_CLIENT_EVENT,
  type DeadlineShape,
  type RoomSnapshotShape,
} from '../shared/protocol'
import type { Room, Team } from '../shared/types'
import type { FsmState } from '../shared/fsm'
import {
  clearPlayerSession,
  createHeartbeatPayload,
  createJoinPayload,
  createPlayerSocket,
  createRejoinPayload,
  loadPlayerSession,
  normalizeRoomCode,
  savePlayerSession,
  type PlayerSocketClient,
} from './playerSocket'
import { acquireScreenWakeLock, releaseScreenWakeLock, type WakeLockHandle } from './wakeLock'

export interface PlayerViewProps {
  socketFactory?: () => PlayerSocketClient
}

type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'kicked'

type DeadlineMap = Partial<Record<DeadlineShape['eventName'], DeadlineShape>>
type BoardClueLookup = RoomSnapshotShape['content']['boardCategories'][number]['clues'][number]
type GameOverState = Extract<FsmState, { state: 'GameOver' }>

const HEARTBEAT_INTERVAL_MS = 10_000
const BUZZ_TAP_LOCK_MS = 700

export default function PlayerView({ socketFactory = createPlayerSocket }: PlayerViewProps) {
  const initialRoomCode = useMemo(() => getRoomCodeFromLocation(), [])
  const initialSession = useMemo(() => loadPlayerSession(), [])

  const [roomCode, setRoomCode] = useState(() => initialRoomCode || initialSession?.roomCode || '')
  const [displayName, setDisplayName] = useState(() => initialSession?.displayName || '')
  const [playerToken, setPlayerToken] = useState<string | undefined>(() => initialSession?.playerToken)
  const [playerId, setPlayerId] = useState<string | undefined>(() => initialSession?.playerId)
  const [snapshot, setSnapshot] = useState<RoomSnapshotShape | null>(null)
  const [deadlines, setDeadlines] = useState<DeadlineMap>({})
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle')
  const [banner, setBanner] = useState<string | null>(null)
  const [errorText, setErrorText] = useState<string | null>(null)
  const [buzzLocked, setBuzzLocked] = useState(false)
  const [wagerValue, setWagerValue] = useState(100)
  const [finalAnswerText, setFinalAnswerText] = useState('')

  const socketRef = useRef<PlayerSocketClient | null>(null)
  const wakeLockRef = useRef<WakeLockHandle | null>(null)
  const heartbeatRef = useRef<number | null>(null)
  const buzzUnlockTimerRef = useRef<number | null>(null)
  const lastAuthKeyRef = useRef('')
  const autoJoinAttemptedRef = useRef(false)
  const joinedRoomCodeRef = useRef<string | null>(null)
  const roomCodeRef = useRef(roomCode)
  const displayNameRef = useRef(displayName)
  const playerTokenRef = useRef(playerToken)
  const playerIdRef = useRef(playerId)

  useEffect(() => {
    roomCodeRef.current = roomCode
  }, [roomCode])

  useEffect(() => {
    displayNameRef.current = displayName
  }, [displayName])

  useEffect(() => {
    playerTokenRef.current = playerToken
  }, [playerToken])

  useEffect(() => {
    playerIdRef.current = playerId
  }, [playerId])

  const ensureSocket = useCallback((): PlayerSocketClient => {
    if (!socketRef.current) {
      socketRef.current = socketFactory()
    }
    return socketRef.current
  }, [socketFactory])

  const startSession = useCallback(
    async (nextRoomCode: string, nextDisplayName: string, nextPlayerToken?: string) => {
      const socket = ensureSocket()
      const normalizedRoomCode = normalizeRoomCode(nextRoomCode)
      const authKey = `${normalizedRoomCode}|${nextDisplayName.trim()}|${nextPlayerToken ?? ''}`
      joinedRoomCodeRef.current = normalizedRoomCode
      setRoomCode(normalizedRoomCode)
      setDisplayName(nextDisplayName.trim())
      setConnectionState('connecting')
      setErrorText(null)
      socket.connect()
      if (authKey === lastAuthKeyRef.current) return
      lastAuthKeyRef.current = authKey
      if (nextPlayerToken) {
        socket.send(CLIENT_TO_SERVER_EVENT.PLAYER_REJOIN, createRejoinPayload(normalizedRoomCode, nextDisplayName, nextPlayerToken))
      } else {
        socket.send(CLIENT_TO_SERVER_EVENT.PLAYER_JOIN, createJoinPayload(normalizedRoomCode, nextDisplayName))
      }
    },
    [ensureSocket],
  )

  useEffect(() => {
    const socket = ensureSocket()
    const offConnect = socket.on('connect', () => {
      setConnectionState((current) => (current === 'kicked' ? current : 'connected'))
      const sessionRoomCode = joinedRoomCodeRef.current || roomCodeRef.current
      const sessionDisplayName = displayNameRef.current.trim()
      const sessionToken = playerTokenRef.current
      if (!sessionRoomCode || !sessionDisplayName) return
      const authKey = `${normalizeRoomCode(sessionRoomCode)}|${sessionDisplayName}|${sessionToken ?? ''}`
      if (authKey === lastAuthKeyRef.current) return
      lastAuthKeyRef.current = authKey
      if (sessionToken) {
        socket.send(CLIENT_TO_SERVER_EVENT.PLAYER_REJOIN, createRejoinPayload(sessionRoomCode, sessionDisplayName, sessionToken))
      } else {
        socket.send(CLIENT_TO_SERVER_EVENT.PLAYER_JOIN, createJoinPayload(sessionRoomCode, sessionDisplayName))
      }
    })
    const offDisconnect = socket.on('disconnect', () => {
      setConnectionState((current) => (current === 'kicked' ? current : current === 'connected' ? 'reconnecting' : 'disconnected'))
    })
    const offSnapshot = socket.on(SERVER_TO_CLIENT_EVENT.SNAPSHOT, (nextSnapshot) => {
      setSnapshot(nextSnapshot)
      if (nextSnapshot.room.code) {
        joinedRoomCodeRef.current = normalizeRoomCode(nextSnapshot.room.code)
      }
      if (!playerIdRef.current && nextSnapshot.room.players.length > 0) {
        const matchingPlayer =
          nextSnapshot.room.players.find((player) => player.token && player.token === playerTokenRef.current) ??
          nextSnapshot.room.players.find((player) => player.displayName === displayNameRef.current)
        if (matchingPlayer) {
          setPlayerId(matchingPlayer.id)
        }
      }
    })
    const offPlayerToken = socket.on(SERVER_TO_CLIENT_EVENT.PLAYER_TOKEN, (payload) => {
      setPlayerToken(payload.playerToken)
      setPlayerId(payload.playerId)
      savePlayerSession({
        roomCode: roomCodeRef.current || joinedRoomCodeRef.current || '',
        displayName: displayNameRef.current.trim(),
        playerToken: payload.playerToken,
        playerId: payload.playerId,
        updatedAtMs: Date.now(),
      })
    })
    const offDeadline = socket.on(SERVER_TO_CLIENT_EVENT.DEADLINE, (payload) => {
      setDeadlines((current) => ({
        ...current,
        [payload.eventName]: payload,
      }))
    })
    const offError = socket.on(SERVER_TO_CLIENT_EVENT.ERROR, (payload) => {
      setErrorText(payload.message)
      setBanner(payload.retryable ? 'Server says this can be retried.' : 'Server rejected the last action.')
    })
    const offKicked = socket.on(SERVER_TO_CLIENT_EVENT.KICKED, (payload) => {
      setConnectionState('kicked')
      setErrorText(payload.reason)
      clearPlayerSession()
      setPlayerToken(undefined)
      setPlayerId(undefined)
    })

    return () => {
      offConnect()
      offDisconnect()
      offSnapshot()
      offPlayerToken()
      offDeadline()
      offError()
      offKicked()
      socket.disconnect()
    }
  }, [ensureSocket])

  useEffect(() => {
    if (!roomCode || !displayName) return
    if (autoJoinAttemptedRef.current) return
    if (!initialSession && !playerToken && !playerId) return
    autoJoinAttemptedRef.current = true
    const timer = window.setTimeout(() => {
      void startSession(roomCode, displayName, playerToken)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [displayName, initialSession, playerId, playerToken, roomCode, startSession])

  useEffect(() => {
    if (!socketRef.current) return
    if (!roomCode || !displayName) return
    if (connectionState === 'kicked') return
    const socket = socketRef.current
    const heartbeat = window.setInterval(() => {
      if (!socket.isConnected()) return
      socket.send(CLIENT_TO_SERVER_EVENT.CLIENT_HEARTBEAT, createHeartbeatPayload(roomCode, playerId, playerToken))
    }, HEARTBEAT_INTERVAL_MS)
    heartbeatRef.current = heartbeat
    return () => {
      window.clearInterval(heartbeat)
      if (heartbeatRef.current === heartbeat) {
        heartbeatRef.current = null
      }
    }
  }, [connectionState, displayName, playerId, playerToken, roomCode])

  useEffect(() => {
    const shouldHoldWakeLock = Boolean(snapshot && connectionState === 'connected')
    if (!shouldHoldWakeLock) {
      void releaseScreenWakeLock(wakeLockRef.current)
      wakeLockRef.current = null
      return
    }
    let cancelled = false
    void acquireScreenWakeLock().then((handle) => {
      if (cancelled) {
        void releaseScreenWakeLock(handle)
        return
      }
      wakeLockRef.current = handle
    })
    return () => {
      cancelled = true
      void releaseScreenWakeLock(wakeLockRef.current)
      wakeLockRef.current = null
    }
  }, [connectionState, snapshot])

  useEffect(() => {
    return () => {
      if (heartbeatRef.current) {
        window.clearInterval(heartbeatRef.current)
      }
      if (buzzUnlockTimerRef.current) {
        window.clearTimeout(buzzUnlockTimerRef.current)
      }
      void releaseScreenWakeLock(wakeLockRef.current)
      socketRef.current?.disconnect()
      socketRef.current?.close()
    }
  }, [])

  const room = snapshot?.room ?? null
  const team = useMemo(() => findTeam(room, playerId, displayName), [displayName, playerId, room])
  const activeGameState = snapshot?.state ?? null
  const currentDeadline = useMemo(() => pickCurrentDeadline(activeGameState, deadlines), [activeGameState, deadlines])
  const currentScreen = deriveCurrentScreen(connectionState, snapshot, roomCode, displayName, playerToken, errorText, team)

  function handleJoinSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const normalizedRoomCode = normalizeRoomCode(roomCode)
    const trimmedName = displayName.trim()
    if (!normalizedRoomCode || !trimmedName) return
    void startSession(normalizedRoomCode, trimmedName, playerToken)
    savePlayerSession({
      roomCode: normalizedRoomCode,
      displayName: trimmedName,
      playerToken,
      playerId,
      updatedAtMs: Date.now(),
    })
  }

  function handleBuzz() {
    if (buzzUnlockTimerRef.current || !snapshot) return
    const socket = ensureSocket()
    setBuzzLocked(true)
    buzzUnlockTimerRef.current = window.setTimeout(() => {
      setBuzzLocked(false)
      buzzUnlockTimerRef.current = null
    }, BUZZ_TAP_LOCK_MS)
    socket.send(CLIENT_TO_SERVER_EVENT.PLAYER_BUZZ, { clueId: getClueId(snapshot) })
  }

  function handleSelectClue(clueId: string) {
    ensureSocket().send(CLIENT_TO_SERVER_EVENT.PLAYER_SELECT_CLUE, { clueId })
  }

  function handleChoice(choiceId: string) {
    if (!snapshot) return
    const clueId = getClueId(snapshot)
    ensureSocket().send(CLIENT_TO_SERVER_EVENT.PLAYER_ANSWER_CHOICE, { clueId, choiceId })
  }

  function handleWagerSubmit(nextWager: number) {
    if (!snapshot) return
    const clueId = getClueId(snapshot)
    ensureSocket().send(CLIENT_TO_SERVER_EVENT.PLAYER_SUBMIT_WAGER, { clueId, wager: nextWager })
  }

  function handleFinalAnswerSubmit(choiceId: string) {
    if (!snapshot) return
    const finalClueId = snapshot.content.finalClue.id
    ensureSocket().send(CLIENT_TO_SERVER_EVENT.PLAYER_SUBMIT_FINAL_ANSWER, { finalClueId, choiceId })
  }

  function handleReconnect() {
    if (!roomCode || !displayName) return
    void startSession(roomCode, displayName, playerToken)
  }

  function handleClearSession() {
    clearPlayerSession()
    setPlayerToken(undefined)
    setPlayerId(undefined)
    setBanner('Stored session cleared.')
  }

  return (
    <main className="player-shell">
      <section className="player-frame">
        <header className="player-header">
          <div className="player-brand">
            <span className="player-chip">SimCity Peds Cards</span>
            <h1>Player</h1>
            <p>Phone-first control panel for the local multiplayer board.</p>
          </div>
          <div className="player-chip" aria-live="polite">
            <strong>{connectionState.toUpperCase()}</strong>
            {room ? <span>Room {room.code}</span> : <span>No room</span>}
          </div>
        </header>

        {banner ? (
          <div className="player-banner" role="status" aria-live="polite">
            <strong>{banner}</strong>
          </div>
        ) : null}

        {errorText ? (
          <div className="player-banner" role="alert">
            <strong>{errorText}</strong>
            <div className="player-actions-row">
              <button className="player-ghost" type="button" onClick={() => setErrorText(null)}>
                Dismiss
              </button>
            </div>
          </div>
        ) : null}

        {currentScreen.kind === 'join' ? (
          <section className="player-card">
            <h2>Join room</h2>
            <p>Enter the room code and your display name. If you already have a saved session, this will try to rejoin it.</p>
            <form className="player-form" onSubmit={handleJoinSubmit}>
              <div className="player-field-grid">
                <div className="player-field">
                  <label htmlFor="roomCode">Room code</label>
                  <input
                    id="roomCode"
                    inputMode="text"
                    autoCapitalize="characters"
                    autoComplete="one-time-code"
                    spellCheck={false}
                    value={roomCode}
                    onChange={(event) => setRoomCode(normalizeRoomCode(event.target.value))}
                    placeholder="AB12"
                  />
                </div>
                <div className="player-field">
                  <label htmlFor="displayName">Display name</label>
                  <input
                    id="displayName"
                    inputMode="text"
                    autoComplete="nickname"
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    placeholder="Maya"
                  />
                </div>
              </div>
              <div className="player-actions">
                <button className="player-touch-target" type="submit" disabled={!normalizeRoomCode(roomCode) || !displayName.trim()}>
                  {playerToken ? 'Rejoin room' : 'Join room'}
                </button>
                <button className="player-ghost player-touch-target" type="button" onClick={handleClearSession}>
                  Clear session
                </button>
              </div>
            </form>
            <p className="player-note">
              {currentScreen.message}
            </p>
          </section>
        ) : null}

        {currentScreen.kind === 'waiting' ? (
          <section className="player-card">
            <h2>{currentScreen.title}</h2>
            <p>{currentScreen.message}</p>
            <div className="player-actions">
              <button className="player-touch-target player-secondary" type="button" onClick={handleReconnect}>
                Reconnect now
              </button>
              <button className="player-touch-target player-ghost" type="button" onClick={handleClearSession}>
                Forget saved token
              </button>
            </div>
            <div className="player-divider" />
            <div className="player-inline">
              <span className="player-status">Name {displayName || 'unset'}</span>
              {team ? <span className="player-status">Team {team.name}</span> : <span className="player-status is-warning">No team yet</span>}
              {currentDeadline ? <span className="player-status">Deadline {formatCountdown(currentDeadline)}</span> : null}
            </div>
          </section>
        ) : null}

        {currentScreen.kind === 'board' ? (
          <section className="player-board">
            <div className="player-board-head">
              <div>
                <h2>Board control</h2>
                <p>{currentScreen.message}</p>
              </div>
              {currentDeadline ? <span className="player-time">{formatCountdown(currentDeadline)}</span> : null}
            </div>
            <div className="player-grid">
              {currentScreen.clues.map((clue) => (
                <article className="player-clue" key={clue.id}>
                  <strong>{clue.category}</strong>
                  <span className="player-muted">{clue.value}</span>
                  <span className="player-small">{clue.prompt}</span>
                  <button className="player-touch-target" type="button" onClick={() => handleSelectClue(clue.id)}>
                    Select clue
                  </button>
                </article>
              ))}
            </div>
          </section>
        ) : null}

        {currentScreen.kind === 'buzz' ? (
          <section className="player-card">
            <h2>Buzz window</h2>
            <p>{currentScreen.message}</p>
            <button className="player-buzz player-full" type="button" disabled={buzzLocked} onClick={handleBuzz}>
              {buzzLocked ? 'Buzz sent' : 'Buzz'}
            </button>
            <div className="player-meta">{currentDeadline ? formatCountdown(currentDeadline) : 'Waiting for the server clock.'}</div>
          </section>
        ) : null}

        {currentScreen.kind === 'answer' ? (
          <section className="player-panel">
            <h2>Team answer</h2>
            <p>{currentScreen.message}</p>
            <div className="player-choice-grid">
              {currentScreen.choices.map((choice) => (
                <button key={choice} className="player-touch-target" type="button" onClick={() => handleChoice(choice)}>
                  {choice}
                </button>
              ))}
            </div>
            {currentDeadline ? <div className="player-deadline">{formatCountdown(currentDeadline)}</div> : null}
          </section>
        ) : null}

        {currentScreen.kind === 'wager' ? (
          <section className="player-panel">
            <h2>{currentScreen.title}</h2>
            <p>{currentScreen.message}</p>
            <div className="player-wager">
              <div className="player-wager-controls">
                <input
                  className="player-wager-range"
                  type="range"
                  min={currentScreen.min}
                  max={currentScreen.max}
                  step={1}
                  value={wagerValue}
                  onChange={(event) => setWagerValue(Number(event.target.value))}
                />
                <button type="button" className="player-secondary" onClick={() => setWagerValue(currentScreen.min)}>
                  Min
                </button>
                <button type="button" onClick={() => handleWagerSubmit(wagerValue)}>
                  Submit
                </button>
              </div>
              <div className="player-inline">
                <strong>{wagerValue}</strong>
                <span className="player-muted">
                  Range {currentScreen.min} to {currentScreen.max}
                </span>
              </div>
            </div>
          </section>
        ) : null}

        {currentScreen.kind === 'final-wager' ? (
          <section className="player-panel">
            <h2>Final wager</h2>
            <p>{currentScreen.message}</p>
            <div className="player-wager">
              <div className="player-wager-controls">
                <input
                  className="player-wager-range"
                  type="range"
                  min={currentScreen.min}
                  max={currentScreen.max}
                  step={1}
                  value={wagerValue}
                  onChange={(event) => setWagerValue(Number(event.target.value))}
                />
                <button type="button" className="player-secondary" onClick={() => setWagerValue(currentScreen.min)}>
                  Min
                </button>
                <button type="button" onClick={() => handleWagerSubmit(wagerValue)}>
                  Submit wager
                </button>
              </div>
            </div>
          </section>
        ) : null}

        {currentScreen.kind === 'final-answer' ? (
          <section className="player-panel">
            <h2>Final answer</h2>
            <p>{currentScreen.message}</p>
            <div className="player-field">
              <label htmlFor="finalAnswer">Type your answer</label>
              <textarea
                id="finalAnswer"
                value={finalAnswerText}
                onChange={(event) => setFinalAnswerText(event.target.value)}
                placeholder="Enter the answer you want the server to judge."
              />
            </div>
            <div className="player-actions">
              <button type="button" onClick={() => handleFinalAnswerSubmit(finalAnswerText.trim())} disabled={!finalAnswerText.trim()}>
                Submit answer
              </button>
              {currentScreen.choices.length ? (
                <div className="player-pill-row">
                  {currentScreen.choices.map((choice) => (
                    <button key={choice} type="button" className="player-secondary" onClick={() => handleFinalAnswerSubmit(choice)}>
                      {choice}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </section>
        ) : null}

        {currentScreen.kind === 'kicked' ? (
          <section className="player-card">
            <h2>Kicked from room</h2>
            <p>{currentScreen.message}</p>
            <button type="button" onClick={handleClearSession}>
              Clear saved token
            </button>
          </section>
        ) : null}

        {currentScreen.kind === 'gameover' ? (
          <section className="player-summary">
            <h2>Game over</h2>
            <p>{currentScreen.message}</p>
            <ul className="player-summary-list">
              {currentScreen.scores.map((score) => (
                <li key={score.teamId}>
                  <strong>{score.teamName}</strong>
                  <span>{score.score}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {snapshot ? (
          <section className="player-card">
            <h2>Room status</h2>
            <p>
              {room ? room.name : 'Waiting for a room.'}
              {team ? ` · Team ${team.name}` : ''}
            </p>
            <div className="player-inline">
              <span className="player-status">Phase {String(activeGameState?.state ?? 'unknown')}</span>
              {currentDeadline ? <span className="player-status">Time {formatCountdown(currentDeadline)}</span> : null}
              <span className="player-status">Updated {new Date(snapshot.generatedAtMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
            </div>
            <div className="player-score-list">
              {room?.teams.map((entry) => (
                <div key={entry.id} className="player-team-card">
                  <strong>{entry.name}</strong>
                  <span className="player-small">{entry.color}</span>
                  <span>{entry.score}</span>
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </section>
    </main>
  )
}

function deriveCurrentScreen(
  connectionState: ConnectionState,
  snapshot: RoomSnapshotShape | null,
  roomCode: string,
  displayName: string,
  playerToken: string | undefined,
  errorText: string | null,
  team: Team | null,
):
  | { kind: 'join'; message: string }
  | { kind: 'waiting'; title: string; message: string }
  | { kind: 'board'; message: string; clues: Array<{ id: string; category: string; value: number; prompt: string }> }
  | { kind: 'buzz'; message: string }
  | { kind: 'answer'; message: string; choices: readonly string[] }
  | { kind: 'wager'; title: string; message: string; min: number; max: number }
  | { kind: 'final-wager'; message: string; min: number; max: number }
  | { kind: 'final-answer'; message: string; choices: readonly string[] }
  | { kind: 'kicked'; message: string }
  | { kind: 'gameover'; message: string; scores: Array<{ teamId: string; teamName: string; score: number }> } {
  if (!roomCode || !displayName || connectionState === 'idle') {
    return {
      kind: 'join',
      message: 'Use the room code from the host QR code. The session token will be stored locally after the first join.',
    }
  }

  if (connectionState === 'kicked') {
    return {
      kind: 'kicked',
      message: errorText || 'This device was removed from the room by the host.',
    }
  }

  if (!snapshot) {
    return {
      kind: 'waiting',
      title: connectionState === 'connecting' ? 'Connecting' : connectionState === 'reconnecting' ? 'Reconnecting' : 'Waiting',
      message: playerToken ? 'Trying to restore your seat in the room.' : 'Waiting for the server to send the latest room snapshot.',
    }
  }

  if (snapshot.state.state === 'GameOver') {
    const gameOverState = snapshot.state as GameOverState
    const entries = (Object.entries(gameOverState.finalScores) as Array<[string, number]>)
      .map(([teamId, score]) => ({
        teamId,
        teamName: snapshot.room.teams.find((team) => team.id === teamId)?.name ?? teamId,
        score,
      }))
      .sort((left, right) => right.score - left.score)
    return {
      kind: 'gameover',
      message: gameOverState.winnerTeamId
        ? `Winner: ${snapshot.room.teams.find((team) => team.id === gameOverState.winnerTeamId)?.name ?? gameOverState.winnerTeamId}`
        : 'Final scores are locked in by the server.',
      scores: entries,
    }
  }

  if (snapshot.state.state === 'BoardIdle') {
    if (!team || snapshot.room.currentTeamId !== team.id) {
      return {
        kind: 'waiting',
        title: 'Waiting for board control',
        message: snapshot.room.currentTeamId
          ? `Board control is with ${snapshot.room.teams.find((entry) => entry.id === snapshot.room.currentTeamId)?.name ?? 'another team'}.`
          : 'Waiting for the server to assign board control.',
      }
    }
    const clues = buildAvailableClues(snapshot)
    return {
      kind: 'board',
      message: snapshot.room.currentTeamId ? 'Your team has board control. Pick a clue.' : 'Waiting for the team that controls the board.',
      clues,
    }
  }

  if (snapshot.state.state === 'BuzzWindow') {
    return {
      kind: 'buzz',
      message: 'Tap once to buzz. The server decides whether you got in first.',
    }
  }

  if (snapshot.state.state === 'TeamAnswering') {
    const boardClue = findCurrentBoardClue(snapshot)
    return {
      kind: 'answer',
      message: 'Choose the answer the server should judge for this clue.',
      choices: boardClue?.answerChoices ?? [],
    }
  }

  if (snapshot.state.state === 'DoubleDownWager') {
    return {
      kind: 'wager',
      title: 'Double down wager',
      message: 'Set the wager allowed by the room. The server will enforce the limits.',
      min: 1,
      max: 1000,
    }
  }

  if (snapshot.state.state === 'FinalWagering') {
    return {
      kind: 'final-wager',
      message: 'Set the final wager. The host and server resolve it from the room state.',
      min: 0,
      max: 1000,
    }
  }

  if (snapshot.state.state === 'FinalAnswering') {
    return {
      kind: 'final-answer',
      message: 'Type the final answer or tap one of the provided answer choices.',
      choices: snapshot.content.finalClue.answerChoices,
    }
  }

  return {
    kind: 'waiting',
    title: snapshot.state.state,
    message: connectionState === 'connected' ? 'Waiting for the next server snapshot.' : 'Connecting to the room.',
  }
}

function buildAvailableClues(snapshot: RoomSnapshotShape): Array<{ id: string; category: string; value: number; prompt: string }> {
  const clues = new Map<string, { id: string; category: string; value: number; prompt: string }>()
  for (const category of snapshot.content.boardCategories) {
    for (const clue of category.clues) {
      clues.set(clue.id, {
        id: clue.id,
        category: category.title,
        value: clue.value,
        prompt: clue.prompt,
      })
    }
  }
  return snapshot.state.state === 'BoardIdle'
    ? snapshot.state.availableClueIds.map((clueId) => clues.get(clueId) || { id: clueId, category: 'Unknown', value: 0, prompt: 'Awaiting clue text.' })
    : []
}

function findCurrentBoardClue(snapshot: RoomSnapshotShape): BoardClueLookup | null {
  const clueId =
    snapshot.state.state === 'ClueReading'
      ? snapshot.state.clue.id
      : snapshot.state.state === 'BuzzWindow' || snapshot.state.state === 'TeamAnswering' || snapshot.state.state === 'DoubleDownWager'
        ? snapshot.state.clueId
        : snapshot.room.currentClueId
  if (!clueId) return null

  for (const category of snapshot.content.boardCategories) {
    for (const clue of category.clues) {
      if (clue.id === clueId) {
        return clue
      }
    }
  }
  return null
}

function findTeam(room: Room | null, playerId: string | undefined, displayName: string): Team | null {
  if (!room) return null
  const player = room.players.find((entry) => entry.id === playerId || entry.displayName === displayName)
  if (!player) return null
  return room.teams.find((team) => team.id === player.teamId) || null
}

function getClueId(snapshot: RoomSnapshotShape): string {
  if (snapshot.state.state === 'TeamAnswering') return snapshot.state.clueId
  if (snapshot.state.state === 'BuzzWindow') return snapshot.state.clueId
  if (snapshot.state.state === 'DoubleDownWager') return snapshot.state.clueId
  if (snapshot.state.state === 'ClueReading') return snapshot.state.clue.id
  return snapshot.room.currentClueId || ''
}

function pickCurrentDeadline(state: FsmState | null, deadlines: DeadlineMap): DeadlineShape | null {
  if (!state) return null
  if (state.state === 'BuzzWindow') return deadlines['player/buzz'] ?? null
  if (state.state === 'TeamAnswering') return deadlines['player/answerChoice'] ?? null
  if (state.state === 'DoubleDownWager') return deadlines['player/submitWager'] ?? null
  if (state.state === 'FinalWagering') return deadlines['player/submitWager'] ?? null
  if (state.state === 'FinalAnswering') return deadlines['player/submitFinalAnswer'] ?? null
  if (state.state === 'BoardIdle') return deadlines['player/selectClue'] ?? null
  return null
}

function formatCountdown(deadline: DeadlineShape): string {
  const remainingMs = Math.max(0, deadline.endsAtMs - Date.now())
  const totalSeconds = Math.ceil(remainingMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')} left`
}

function getRoomCodeFromLocation(): string {
  try {
    const url = new URL(window.location.href)
    return normalizeRoomCode(url.searchParams.get('room') || '')
  } catch {
    return ''
  }
}
