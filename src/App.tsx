import './App.css'
import HostView from './client/HostView'
import PlayerView from './client/PlayerView'

export default function App() {
  const pathname = window.location.pathname

  if (pathname.startsWith('/player')) {
    return <PlayerView />
  }

  return <HostView />
}
