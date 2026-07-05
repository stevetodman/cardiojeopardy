import { io } from 'socket.io-client'
import type {
  ServerToClientEventName,
  ServerToClientPayloadMap,
} from '../shared/protocol'

type HostLifecycleEvent = 'connect' | 'disconnect' | 'error'

export interface HostSocket {
  connected: boolean
  emit: (eventName: string, payload: unknown) => void
  on: {
    (eventName: 'connect_error', handler: (error: Error) => void): HostSocket
    (eventName: HostLifecycleEvent, handler: (...args: unknown[]) => void): HostSocket
    <TName extends ServerToClientEventName>(
      eventName: TName,
      handler: (payload: ServerToClientPayloadMap[TName]) => void,
    ): HostSocket
  }
  off: {
    (eventName: 'connect_error', handler?: (error: Error) => void): HostSocket
    (eventName: HostLifecycleEvent, handler?: (...args: unknown[]) => void): HostSocket
    <TName extends ServerToClientEventName>(
      eventName: TName,
      handler?: (payload: ServerToClientPayloadMap[TName]) => void,
    ): HostSocket
  }
  disconnect: () => HostSocket
}

export function createHostSocket(): HostSocket {
  return io(window.location.origin, {
    autoConnect: true,
    transports: ['websocket'],
  }) as unknown as HostSocket
}
