import { render, screen } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import App from '../../src/App'

describe('app routes', () => {
  test('renders the host room creation screen at root', () => {
    window.history.replaceState({}, '', '/')
    render(<App />)

    expect(screen.getByRole('heading', { name: 'Peds Cardio Quiz Board' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create room' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Player route' })).toHaveAttribute('href', '/player')
  })

  test('renders the player join screen at /player', () => {
    window.history.replaceState({}, '', '/player?room=ABCD')
    render(<App />)

    expect(screen.getByRole('heading', { name: 'Player' })).toBeInTheDocument()
    expect(screen.getByLabelText('Room code')).toHaveValue('ABCD')
    expect(screen.getByLabelText('Display name')).toBeInTheDocument()
  })
})
