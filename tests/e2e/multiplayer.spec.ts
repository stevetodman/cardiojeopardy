import { expect, test } from '@playwright/test'

test('host and two phone players can play the first clue', async ({ browser }) => {
  const hostContext = await browser.newContext()
  const playerOneContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  })
  const playerTwoContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  })

  try {
    const host = await hostContext.newPage()
    await host.goto('/')
    await expect(host.getByRole('heading', { name: 'Peds Cardio Quiz Board' })).toBeVisible()
    await host.getByRole('button', { name: 'Create room' }).click()

    await expect.poll(() => new URL(host.url()).searchParams.get('room')).toBeTruthy()
    const roomCode = new URL(host.url()).searchParams.get('room')
    expect(roomCode).toBeTruthy()
    await expect(host.getByText(`Room ${roomCode}`)).toBeVisible()

    const playerOne = await playerOneContext.newPage()
    await playerOne.goto(`/player?room=${roomCode}`)
    await playerOne.getByLabel('Display name').fill('Ada')
    await playerOne.getByRole('button', { name: /join room/i }).click()
    await expect(playerOne.getByText(`Room ${roomCode}`)).toBeVisible()

    const playerTwo = await playerTwoContext.newPage()
    await playerTwo.goto(`/player?room=${roomCode}`)
    await playerTwo.getByLabel('Display name').fill('Ben')
    await playerTwo.getByRole('button', { name: /join room/i }).click()
    await expect(playerTwo.getByText(`Room ${roomCode}`)).toBeVisible()

    await expect(host.getByText('Ada').first()).toBeVisible()
    await expect(host.getByText('Ben').first()).toBeVisible()

    await host.getByRole('button', { name: 'Start game' }).click()
    await expect(playerOne.getByRole('heading', { name: 'Board control' })).toBeVisible({ timeout: 12_000 })
    await playerOne.getByRole('button', { name: 'Select clue' }).first().click()

    await expect(playerOne.getByRole('heading', { name: 'Buzz window' })).toBeVisible({ timeout: 12_000 })
    await playerOne.getByRole('button', { name: /^Buzz$/ }).click()
    await expect(playerOne.getByRole('heading', { name: 'Team answer' })).toBeVisible()
    await playerOne.getByRole('button', { name: "Still's innocent murmur" }).click()

    await expect(host.getByText('$200').first()).toBeVisible({ timeout: 8_000 })
  } finally {
    await hostContext.close()
    await playerOneContext.close()
    await playerTwoContext.close()
  }
})
