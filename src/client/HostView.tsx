import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import QRCode from 'qrcode'
import {
  CLIENT_TO_SERVER_EVENT,
  FINAL_INTRO_MS,
  FINAL_REVEAL_MS,
  type CreateRoomIntent,
  type DeadlineShape,
  type HostFinalOverrideIntent,
  type HostKickPlayerIntent,
  type HostPauseIntent,
  type HostResetRoomIntent,
  type HostResumeIntent,
  type RoomSnapshotShape,
  type ServerRoomCreatedPayload,
} from '../shared/protocol'
import type { BoardClueTemplate, ClueStatus, FinalClueState, Room, Team } from '../shared/types'
import type { FsmState } from '../shared/fsm'
import { createHostSocket, type HostSocket } from './hostSocket'
import './HostView.css'

const DEFAULT_ROOM_NAME = 'Peds Cardio Quiz Board'
const DEFAULT_HOST_NAME = 'Host'
const PLAYER_ROUTE = '/player'

type ConnectionState = 'connecting' | 'connected' | 'disconnected'

const stateLabels: Record<FsmState['state'], string> = {
  Setup: 'Setup',
  RoomLobby: 'Lobby',
  RoundIntro: 'Round intro',
  BoardIdle: 'Board idle',
  ClueReading: 'Clue reading',
  BuzzWindow: 'Buzz window',
  TeamAnswering: 'Team answering',
  Adjudication: 'Adjudication',
  ClueResolution: 'Resolution',
  DoubleDownWager: 'Wagering',
  RoundTransition: 'Round transition',
  FinalIntro: 'Final intro',
  FinalWagering: 'Final wagering',
  FinalAnswering: 'Final answering',
  FinalReveal: 'Final reveal',
  GameOver: 'Game over',
}

const statusLabels: Record<ClueStatus, string> = {
  locked: 'Locked',
  available: 'Available',
  selected: 'Selected',
  reading: 'Reading',
  buzzing: 'Buzzing',
  answering: 'Answering',
  adjudicating: 'Adjudicating',
  resolved: 'Resolved',
  expired: 'Expired',
}

export default function HostView() {
  const [socketState, setSocketState] = useState<ConnectionState>('connecting')
  const [socketError, setSocketError] = useState<string | null>(null)
  const [pendingCreate, setPendingCreate] = useState(false)
  const [snapshot, setSnapshot] = useState<RoomSnapshotShape | null>(null)
  const [createdRoom, setCreatedRoom] = useState<ServerRoomCreatedPayload | null>(null)
  const [roomName, setRoomName] = useState(DEFAULT_ROOM_NAME)
  const [hostName, setHostName] = useState(DEFAULT_HOST_NAME)
  const [joinQr, setJoinQr] = useState<string>('')
  const [now, setNow] = useState(() => Date.now())
  const [deadlineMap, setDeadlineMap] = useState<Partial<Record<DeadlineShape['eventName'], DeadlineShape>>>({})
  const socketRef = useRef<HostSocket | null>(null)

  useEffect(() => {
    const socket = createHostSocket()
    socketRef.current = socket

    const handleConnect = () => {
      setSocketState('connected')
      setSocketError(null)
    }
    const handleDisconnect = () => setSocketState('disconnected')
    const handleError = (payload: { message: string }) => {
      setSocketError(payload.message)
      setPendingCreate(false)
    }
    const handleSnapshot = (next: RoomSnapshotShape) => {
      setSnapshot(next)
      setPendingCreate(false)
    }
    const handleRoomCreated = (payload: ServerRoomCreatedPayload) => {
      setCreatedRoom(payload)
      setSnapshot(payload.snapshot)
      setPendingCreate(false)
      syncRoomCodeInUrl(payload.roomCode)
    }
    const handleDeadline = (payload: DeadlineShape) => {
      setDeadlineMap((previous) => ({ ...previous, [payload.eventName]: payload }))
    }

    socket.on('connect', handleConnect)
    const handleConnectError = (error: Error) => {
      handleDisconnect()
      setSocketError(error.message)
    }

    socket.on('disconnect', handleDisconnect)
    socket.on('connect_error', handleConnectError)
    socket.on('server/error', handleError)
    socket.on('server/snapshot', handleSnapshot)
    socket.on('server/roomCreated', handleRoomCreated)
    socket.on('server/deadline', handleDeadline)

    if (socket.connected) {
      handleConnect()
    }

    return () => {
      socket.off('connect', handleConnect)
      socket.off('disconnect', handleDisconnect)
      socket.off('connect_error', handleConnectError)
      socket.off('server/error', handleError)
      socket.off('server/snapshot', handleSnapshot)
      socket.off('server/roomCreated', handleRoomCreated)
      socket.off('server/deadline', handleDeadline)
      socket.disconnect()
      socketRef.current = null
    }
  }, [socketRef])

  const room = snapshot?.room ?? createdRoom?.snapshot.room ?? null
  const state = snapshot?.state ?? createdRoom?.snapshot.state ?? null
  const content = snapshot?.content ?? createdRoom?.snapshot.content ?? null
  const roomCode = room?.code ?? extractRoomCodeFromLocation()
  const joinUrl = getServerJoinUrl(snapshot, createdRoom) ?? (roomCode ? buildJoinUrl(roomCode) : '')
  const canCreateRoom = socketState !== 'disconnected'
  const activeDeadline = state ? getStateDeadlineMs(state, deadlineMap) : null
  const isFinalReveal = state?.state === 'FinalReveal'
  const activeClue = state && content ? getActiveClueState(state, content) : null

  useEffect(() => {
    if (!roomCode) return

    let cancelled = false
    void QRCode.toDataURL(joinUrl, { margin: 1, scale: 8, errorCorrectionLevel: 'M' }).then((dataUrl) => {
      if (!cancelled) {
        setJoinQr(dataUrl)
      }
    })

    return () => {
      cancelled = true
    }
  }, [joinUrl, roomCode])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (roomCode) {
      syncRoomCodeInUrl(roomCode)
    }
  }, [roomCode])

  const ranking = useMemo(() => {
    if (!room || !state) return []
    const scores = getRankedScores(room, state)
    return scores
  }, [room, state])

  function emitCreateRoom() {
    const socket = socketRef.current
    if (!socket) return

    const payload: CreateRoomIntent = {
      roomName: roomName.trim() || DEFAULT_ROOM_NAME,
      hostName: hostName.trim() || DEFAULT_HOST_NAME,
    }
    setSocketError(null)
    setPendingCreate(true)
    socket.emit(CLIENT_TO_SERVER_EVENT.HOST_CREATE_ROOM, payload)
  }

  function emitPause() {
    emitHostControl(CLIENT_TO_SERVER_EVENT.HOST_PAUSE, { reason: 'Host projection pause' } satisfies HostPauseIntent)
  }

  function emitResume() {
    emitHostControl(CLIENT_TO_SERVER_EVENT.HOST_RESUME, { reason: 'Host projection resume' } satisfies HostResumeIntent)
  }

  function emitResetRoom() {
    if (!window.confirm('Reset the room and clear the current game?')) return
    emitHostControl(CLIENT_TO_SERVER_EVENT.HOST_RESET_ROOM, { hardReset: true, note: 'Host reset from projection' } satisfies HostResetRoomIntent)
  }

  function emitKickPlayer(playerId: string) {
    emitHostControl(CLIENT_TO_SERVER_EVENT.HOST_KICK_PLAYER, { playerId, reason: 'Disconnected from host console' } satisfies HostKickPlayerIntent)
  }

  function emitFinalOverride(teamId: string, correct: boolean, clue: FinalClueState | null) {
    if (!clue) return
    emitHostControl(CLIENT_TO_SERVER_EVENT.HOST_FINAL_OVERRIDE, {
      teamId,
      answerId: clue.answerByTeamId[teamId],
      correct,
      note: correct ? 'Host override marked correct during reveal' : 'Host override marked incorrect during reveal',
    } satisfies HostFinalOverrideIntent)
  }

  function emitHostControl(
    eventName: (typeof CLIENT_TO_SERVER_EVENT)[keyof typeof CLIENT_TO_SERVER_EVENT],
    payload: unknown,
  ) {
    const socket = socketRef.current
    if (!socket) return
    setSocketError(null)
    socket.emit(eventName, payload)
  }

  if (!state || !room || !content) {
    return (
      <main className="host-shell host-shell-create">
        <section className="create-panel">
          <div className="create-copy">
            <p className="eyebrow">Local multiplayer host</p>
            <h1>Peds Cardio Quiz Board</h1>
            <p>Start a room, hand players the join link, and project the board on the main display.</p>
          </div>

          <div className="create-form">
            <label>
              <span>Room name</span>
              <input value={roomName} onChange={(event) => setRoomName(event.target.value)} placeholder="Peds Cardio Quiz Board" />
            </label>
            <label>
              <span>Host name</span>
              <input value={hostName} onChange={(event) => setHostName(event.target.value)} placeholder="Host" />
            </label>
            <button type="button" className="primary-button" disabled={!canCreateRoom || pendingCreate} onClick={emitCreateRoom}>
              {pendingCreate ? 'Creating room...' : 'Create room'}
            </button>
            <a className="player-link" href={PLAYER_ROUTE}>
              Player route
            </a>
          </div>
        </section>
        <aside className="create-side">
          <section className="info-card">
            <h2>Connection</h2>
            <p className="status-line">{socketState}</p>
            <p className="muted-copy">
              The host socket uses the local server origin. Once a room exists, the QR code and join URL appear here.
            </p>
            {socketError ? <p className="error-copy">{socketError}</p> : null}
          </section>
          <section className="info-card">
            <h2>Route</h2>
            <p className="muted-copy">The host screen stays on `/`. The player path is reserved for the player UI worker.</p>
          </section>
        </aside>
      </main>
    )
  }

  const phaseLabel = stateLabels[state.state]
  const remainingLabel = activeDeadline ? formatRemaining(activeDeadline - now) : null

  return (
    <main className="host-shell">
      <header className="host-header">
        <div className="host-title">
          <p className="eyebrow">Host projection</p>
          <h1>Peds Cardio Quiz Board</h1>
          <p className="subtle-copy">
            Room <strong>{room.code}</strong> · {room.name}
          </p>
        </div>
        <div className="host-header-meta">
          <span className={`connection-pill connection-${socketState}`}>{socketState}</span>
          <span className={`state-pill state-${state.state.toLowerCase()}`}>{phaseLabel}</span>
          {remainingLabel ? <span className="timer-pill">{remainingLabel}</span> : null}
        </div>
      </header>

      {socketError ? <p className="error-banner">{socketError}</p> : null}

      <section className="host-workspace">
        <article className={`projection-frame projection-${state.state.toLowerCase()}`}>
          <div className="projection-topline">
            <div>
              <span className="topline-label">Current state</span>
              <strong>{phaseLabel}</strong>
            </div>
            <div>
              <span className="topline-label">Round</span>
              <strong>{room.roundNumber}</strong>
            </div>
            <div>
              <span className="topline-label">Timer</span>
              <strong>{remainingLabel ?? 'None'}</strong>
            </div>
            <div>
              <span className="topline-label">Score lead</span>
              <strong>{ranking[0] ? `${ranking[0].team.name} ${formatScore(ranking[0].score)}` : 'No teams yet'}</strong>
            </div>
          </div>

          {state.state === 'GameOver' ? (
            <GameOverProjection content={content} state={state} ranking={ranking} />
          ) : state.state === 'FinalReveal' ? (
            <FinalRevealProjection finalClue={state.finalClue} ranking={ranking} onOverride={emitFinalOverride} />
          ) : state.state === 'FinalIntro' ? (
            <FinalIntroProjection state={state} />
          ) : state.state === 'RoundIntro' || state.state === 'RoundTransition' ? (
            <TransitionProjection state={state} />
          ) : (
            <BoardProjection room={room} content={content} state={state} activeClue={activeClue} />
          )}
        </article>

        <aside className="host-rail">
          <section className="info-card room-card">
            <h2>Room</h2>
            <div className="room-summary">
              <div>
                <span className="topline-label">Room code</span>
                <strong>{room.code}</strong>
              </div>
              <div>
                <span className="topline-label">Join URL</span>
                <a href={joinUrl}>{joinUrl}</a>
              </div>
            </div>
            <div className="qr-wrap">
              {joinQr ? <img src={joinQr} alt={`QR code for ${joinUrl}`} /> : <div className="qr-placeholder">QR pending</div>}
            </div>
            <p className="muted-copy">Use the player route on another device to join with the room code above.</p>
          </section>

          <section className="info-card">
            <h2>Teams</h2>
            <div className="team-list">
              {room.teams.map((team) => (
                <div key={team.id} className="team-row" style={{ '--team-color': team.color } as CSSProperties}>
                  <div>
                    <strong>{team.name}</strong>
                    <span>{formatScore(getTeamScore(team, state))}</span>
                  </div>
                  <span className="team-chip" />
                </div>
              ))}
            </div>
          </section>

          <section className="info-card">
            <h2>Players</h2>
            <div className="player-list">
              {room.players.map((player) => (
                <div key={player.id} className={`player-row ${player.connected ? 'connected' : 'disconnected'}`}>
                  <div>
                    <strong>{player.displayName}</strong>
                    <span>{player.connected ? 'Connected' : 'Disconnected'}</span>
                  </div>
                  {!player.isHost && !player.connected ? (
                    <button type="button" className="ghost-button" onClick={() => emitKickPlayer(player.id)}>
                      Kick
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          </section>

          <section className="info-card controls-card">
            <h2>Host controls</h2>
            <div className="control-grid">
              <button type="button" className="secondary-button" onClick={emitPause} disabled={room.status === 'paused'}>
                Pause
              </button>
              <button type="button" className="secondary-button" onClick={emitResume} disabled={room.status !== 'paused'}>
                Resume
              </button>
              <button type="button" className="secondary-button" onClick={emitResume} disabled={room.status !== 'lobby'}>
                Start game
              </button>
              <button type="button" className="danger-button" onClick={emitResetRoom}>
                Reset room
              </button>
            </div>
            {isFinalReveal ? (
              <div className="override-note">
                <strong>Final override</strong>
                <p>Use the reveal controls on the stage to mark the current answer correct or incorrect.</p>
              </div>
            ) : null}
          </section>
        </aside>
      </section>
    </main>
  )
}

function BoardProjection({
  room,
  content,
  state,
  activeClue,
}: {
  room: Room
  content: RoomSnapshotShape['content']
  state: FsmState
  activeClue: ReturnType<typeof getActiveClueState>
}) {
  const categories = content.boardCategories
    .map((category) => ({
      ...category,
      clues: category.clues.filter((clue) => (clue.round ?? room.roundNumber) === room.roundNumber),
    }))
    .filter((category) => category.clues.length > 0)
  const clueRows = Math.max(...categories.map((category) => category.clues.length), 0)

  return (
    <div className="board-layout">
      <section className="score-strip" aria-label="Scores">
        {room.teams.map((team) => (
            <div key={team.id} className="score-tile" style={{ '--team-color': team.color } as CSSProperties}>
            <span>{team.name}</span>
            <strong>{formatScore(getTeamScore(team, state))}</strong>
          </div>
        ))}
      </section>

      <section
        className="board-grid"
        style={{
          gridTemplateColumns: categories.length ? `repeat(${categories.length}, minmax(0, 1fr))` : '1fr',
          gridTemplateRows: clueRows ? `auto repeat(${clueRows}, minmax(0, 1fr))` : 'auto',
        }}
      >
        {categories.map((category) => (
          <div key={category.id} className="category-header">
            <strong>{category.title}</strong>
            {category.description ? <span>{category.description}</span> : null}
          </div>
        ))}

        {Array.from({ length: clueRows }).map((_, rowIndex) =>
          categories.map((category) => {
            const clue = category.clues[rowIndex]
            if (!clue) {
              return <div key={`${category.id}-${rowIndex}`} className="clue-cell empty-cell" />
            }

            const clueState = getBoardClueStatus(room, state, clue)
            return (
              <div key={clue.id} className={`clue-cell clue-${clueState.status}`}>
                <span className="clue-value">{formatDollarValue(clue.value)}</span>
                <span className="clue-status">{statusLabels[clueState.status]}</span>
              </div>
            )
          }),
        )}
      </section>

      <section className="clue-display">
        {activeClue ? (
          activeClue.kind === 'board' ? (
            <BoardClueDisplay clue={activeClue.clue} state={state} />
          ) : (
            <FinalClueDisplay state={state} finalClue={activeClue.clue} />
          )
        ) : (
          <div className="clue-empty">
            <h2>Board live</h2>
            <p>Select a clue to open the reading, buzz, and adjudication flow from the server snapshot.</p>
          </div>
        )}
      </section>
    </div>
  )
}

function BoardClueDisplay({ clue, state }: { clue: BoardClueTemplate; state: FsmState }) {
  return (
    <div className="clue-card">
      <div className="clue-kicker">Clue {clue.value}</div>
      <h2>{clue.prompt}</h2>
      <p className="clue-stem">{clue.clue}</p>
      <div className="choice-grid">
        {clue.answerChoices.map((choice, index) => (
          <div key={choice} className={`choice-chip ${isCorrectChoice(clue, choice) ? 'correct-choice' : ''}`}>
            <span className="choice-index">{String.fromCharCode(65 + index)}</span>
            <span>{choice}</span>
          </div>
        ))}
      </div>
      <div className="clue-meta">
        <span>{stateLabels[state.state]}</span>
        {state.state === 'Adjudication' ? <span>Awaiting host adjudication</span> : null}
        {state.state === 'BuzzWindow' && state.buzzedByPlayerId ? <span>Buzzed by player {state.buzzedByPlayerId}</span> : null}
      </div>
      {'explanation' in clue ? <p className="clue-explanation">{clue.explanation}</p> : null}
    </div>
  )
}

function FinalClueDisplay({
  state,
  finalClue,
}: {
  state: FsmState
  finalClue: RoomSnapshotShape['content']['finalClue'] | FinalClueState
}) {
  const statusText = 'status' in finalClue ? statusLabels[finalClue.status] : stateLabels[state.state]
  return (
    <div className="clue-card final-clue-card">
      <div className="clue-kicker">Final clue</div>
      <h2>{finalClue.prompt}</h2>
      <div className="choice-grid final-choice-grid">
        {finalClue.answerChoices.map((choice, index) => (
          <div key={choice} className={`choice-chip ${finalClue.correctAnswerId === choice ? 'correct-choice' : ''}`}>
            <span className="choice-index">{String.fromCharCode(65 + index)}</span>
            <span>{choice}</span>
          </div>
        ))}
      </div>
      <div className="final-summary">
        <div>
          <span className="topline-label">State</span>
          <strong>{stateLabels[state.state]}</strong>
        </div>
        <div>
          <span className="topline-label">Status</span>
          <strong>{statusText}</strong>
        </div>
      </div>
      <p className="clue-explanation">{finalClue.explanation}</p>
      <ReferenceList references={finalClue.references} />
    </div>
  )
}

function FinalRevealProjection({
  finalClue,
  ranking,
  onOverride,
}: {
  finalClue: FinalClueState
  ranking: ReadonlyArray<{ team: Team; score: number }>
  onOverride: (teamId: string, correct: boolean, clue: FinalClueState | null) => void
}) {
  return (
    <div className="reveal-layout">
      <section className="reveal-hero">
        <h2>Final reveal</h2>
        <p>{finalClue.prompt}</p>
        <ReferenceList references={finalClue.references} />
      </section>
      <section className="reveal-table">
        {ranking.map(({ team, score }) => {
          const answerId = finalClue.answerByTeamId[team.id]
          const wager = finalClue.wagerByTeamId[team.id]
          const choiceText = answerId ? finalClue.answerChoices.find((choice) => choice === answerId) ?? answerId : 'No answer'
          return (
            <article key={team.id} className="reveal-row" style={{ '--team-color': team.color } as CSSProperties}>
              <div className="reveal-row-head">
                <strong>{team.name}</strong>
                <span>{formatScore(score)}</span>
              </div>
              <p>{choiceText}</p>
              <p className="muted-copy">Wager {formatScore(wager ?? 0)}</p>
              <div className="reveal-actions">
                <button type="button" className="secondary-button" onClick={() => onOverride(team.id, true, finalClue)}>
                  Mark correct
                </button>
                <button type="button" className="secondary-button" onClick={() => onOverride(team.id, false, finalClue)}>
                  Mark incorrect
                </button>
              </div>
            </article>
          )
        })}
      </section>
      <section className="reveal-explanation">
        <h3>Explanation</h3>
        <p>{finalClue.explanation}</p>
      </section>
    </div>
  )
}

function FinalIntroProjection({ state }: { state: Extract<FsmState, { state: 'FinalIntro' }> }) {
  return (
    <div className="banner-panel">
      <p className="clue-kicker">Final round</p>
      <h2>Answers locked, wagers next</h2>
      <p>{state.finalClue.prompt}</p>
      <div className="banner-meta">
        <span>{stateLabels[state.state]}</span>
        <span>Starts at {new Date(state.startsAtMs).toLocaleTimeString()}</span>
      </div>
    </div>
  )
}

function TransitionProjection({ state }: { state: Extract<FsmState, { state: 'RoundIntro' | 'RoundTransition' }> }) {
  return (
    <div className="banner-panel">
      <p className="clue-kicker">Round flow</p>
      <h2>{state.state === 'RoundIntro' ? state.headline : 'Between rounds'}</h2>
      <p>
        {state.state === 'RoundIntro' ? 'The next board is loading.' : 'Scoring is settling before the next round opens.'}
      </p>
      <div className="banner-meta">
        <span>{stateLabels[state.state]}</span>
        <span>Ends at {new Date(state.endsAtMs).toLocaleTimeString()}</span>
      </div>
    </div>
  )
}

function GameOverProjection({
  content,
  state,
  ranking,
}: {
  content: RoomSnapshotShape['content']
  state: Extract<FsmState, { state: 'GameOver' }>
  ranking: ReadonlyArray<{ team: Team; score: number }>
}) {
  return (
    <div className="gameover-layout">
      <section className="ranking-panel">
        <h2>Final ranking</h2>
        {ranking.map(({ team, score }, index) => (
          <div key={team.id} className="ranking-row" style={{ '--team-color': team.color } as CSSProperties}>
            <span className="ranking-place">{index + 1}</span>
            <strong>{team.name}</strong>
            <span>{formatScore(score)}</span>
          </div>
        ))}
      </section>
      <section className="review-panel">
        <h2>Post-game review</h2>
        <div className="review-grid">
          {content.boardCategories.map((category) => (
            <article key={category.id} className="review-category">
              <h3>{category.title}</h3>
              {category.clues.map((clue) => (
                <div key={clue.id} className="review-clue">
                  <strong>{formatDollarValue(clue.value)}</strong>
                  <p>{clue.prompt}</p>
                  <p className="muted-copy">{clue.clue}</p>
                  <p className="answer-line">Correct answer: {choiceText(clue, clue.correctAnswerId)}</p>
                  <p className="muted-copy">{clue.explanation}</p>
                  <ReferenceList references={clue.references} />
                </div>
              ))}
            </article>
          ))}
        </div>
        <section className="final-review">
          <h3>Final clue</h3>
          <p>{content.finalClue.prompt}</p>
          <p className="answer-line">Correct answer: {choiceText(content.finalClue, content.finalClue.correctAnswerId)}</p>
          <p className="muted-copy">{content.finalClue.explanation}</p>
          <ReferenceList references={content.finalClue.references} />
        </section>
        <p className="muted-copy">Game over at {new Date(state.endedAtMs).toLocaleTimeString()}</p>
      </section>
    </div>
  )
}

function ReferenceList({ references }: { references: ReadonlyArray<{ id: string; label: string; sourceType: string; url?: string; filePath?: string; supports: string }> }) {
  if (!references.length) {
    return null
  }

  return (
    <ul className="reference-list">
      {references.map((reference) => (
        <li key={reference.id}>
          {reference.url ? (
            <a href={reference.url} target="_blank" rel="noreferrer">
              {reference.label}
            </a>
          ) : reference.filePath ? (
            <span>{reference.label}</span>
          ) : (
            <span>{reference.label}</span>
          )}
        </li>
      ))}
    </ul>
  )
}

function getActiveClueState(state: FsmState, content: RoomSnapshotShape['content']) {
  if (
    state.state === 'ClueReading' ||
    state.state === 'BuzzWindow' ||
    state.state === 'TeamAnswering' ||
    state.state === 'Adjudication' ||
    state.state === 'ClueResolution' ||
    state.state === 'DoubleDownWager'
  ) {
    const clueId = state.state === 'ClueReading' ? state.clue.id : 'clueId' in state ? (state.clueId as string | undefined) : null
    const clue = clueId ? findBoardClue(content, clueId) : null
    if (clue) {
      return { kind: 'board' as const, clue }
    }
  }

  if (
    state.state === 'FinalIntro' ||
    state.state === 'FinalWagering' ||
    state.state === 'FinalAnswering' ||
    state.state === 'FinalReveal'
  ) {
    const finalClue = 'finalClue' in state ? (state.finalClue as FinalClueState) : content.finalClue
    if (finalClue) {
      return { kind: 'final' as const, clue: finalClue }
    }
  }

  return null
}

function getBoardClueStatus(room: Room, state: FsmState, clue: BoardClueTemplate): { status: ClueStatus } {
  const currentClueId = 'clueId' in state ? (state.clueId as string | undefined) : room.currentClueId
  const availableClueIds = 'availableClueIds' in state ? (state.availableClueIds as readonly string[]) : []
  if (state.state === 'GameOver') {
    return { status: 'resolved' }
  }

  if (currentClueId === clue.id) {
    if (state.state === 'ClueReading') return { status: 'reading' }
    if (state.state === 'BuzzWindow') return { status: state.buzzedByPlayerId ? 'buzzing' : 'reading' }
    if (state.state === 'TeamAnswering') return { status: 'answering' }
    if (state.state === 'Adjudication') return { status: 'adjudicating' }
    if (state.state === 'ClueResolution') return { status: 'resolved' }
    if (state.state === 'DoubleDownWager') return { status: 'selected' }
    return { status: 'selected' }
  }

  if (state.state === 'BoardIdle') {
    return { status: availableClueIds.includes(clue.id) ? 'available' : 'resolved' }
  }

  if (state.state === 'RoomLobby' || state.state === 'Setup' || state.state === 'RoundIntro' || state.state === 'RoundTransition' || state.state === 'FinalIntro' || state.state === 'FinalWagering' || state.state === 'FinalAnswering') {
    return { status: 'locked' }
  }

  if (availableClueIds.length && !availableClueIds.includes(clue.id)) {
    return { status: 'resolved' }
  }

  return { status: 'available' }
}

function getTeamScore(team: Team, state: FsmState): number {
  if (state.state === 'GameOver') {
    return state.finalScores[team.id] ?? team.score
  }
  return team.score
}

function getRankedScores(room: Room, state: FsmState) {
  return [...room.teams]
    .map((team) => ({ team, score: getTeamScore(team, state) }))
    .sort((left, right) => right.score - left.score || left.team.name.localeCompare(right.team.name))
}

function getStateDeadlineMs(state: FsmState, deadlineMap: Partial<Record<DeadlineShape['eventName'], DeadlineShape>>) {
  if (state.state === 'RoundIntro') return state.endsAtMs
  if (state.state === 'ClueReading') return state.endsAtMs
  if (state.state === 'BuzzWindow') return state.closesAtMs
  if (state.state === 'TeamAnswering') return state.answerDueAtMs
  if (state.state === 'RoundTransition') return state.endsAtMs
  if (state.state === 'FinalWagering') return state.wagerDueAtMs
  if (state.state === 'FinalAnswering') return state.answerDueAtMs
  if (state.state === 'FinalIntro') return state.startsAtMs + FINAL_INTRO_MS
  if (state.state === 'FinalReveal') return state.revealedAtMs + FINAL_REVEAL_MS
  if (state.state === 'DoubleDownWager') {
    return deadlineMap['player/submitWager']?.endsAtMs ?? null
  }
  return null
}

function findBoardClue(content: RoomSnapshotShape['content'], clueId: string) {
  for (const category of content.boardCategories) {
    const found = category.clues.find((clue) => clue.id === clueId)
    if (found) {
      return found
    }
  }
  return null
}

function choiceText(clue: { answerChoices: readonly string[] }, choiceId: string) {
  return clue.answerChoices.find((choice) => choice === choiceId) ?? choiceId
}

function isCorrectChoice(clue: BoardClueTemplate, choice: string) {
  return clue.correctAnswerId === choice
}

function formatDollarValue(value: number) {
  return `$${value}`
}

function formatScore(value: number) {
  return value >= 0 ? `$${value}` : `-$${Math.abs(value)}`
}

function formatRemaining(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function buildJoinUrl(roomCode: string) {
  return new URL(`${PLAYER_ROUTE}?room=${encodeURIComponent(roomCode)}`, window.location.origin).toString()
}

function getServerJoinUrl(snapshot: RoomSnapshotShape | null, createdRoom: ServerRoomCreatedPayload | null): string | null {
  return snapshot?.playerJoinUrl ?? snapshot?.joinUrl ?? createdRoom?.playerJoinUrl ?? createdRoom?.joinUrl ?? createdRoom?.snapshot.playerJoinUrl ?? createdRoom?.snapshot.joinUrl ?? null
}

function extractRoomCodeFromLocation() {
  const url = new URL(window.location.href)
  const searchCode = url.searchParams.get('room')
  if (searchCode) {
    return searchCode
  }

  const pathMatch = url.pathname.match(/^\/room\/([^/]+)$/)
  return pathMatch ? decodeURIComponent(pathMatch[1]) : ''
}

function syncRoomCodeInUrl(roomCode: string) {
  const url = new URL(window.location.href)
  url.searchParams.set('room', roomCode)
  window.history.replaceState({}, '', url)
}
