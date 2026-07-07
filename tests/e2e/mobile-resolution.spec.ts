import { devices, expect, test, type BrowserContext, type Page } from '@playwright/test'

const iphoneDeviceNames = ['iPhone 12 Mini', 'iPhone 12', 'iPhone 12 Pro Max', 'iPhone 15', 'iPhone 16 Pro Max'] as const

interface OverflowReport {
  viewportWidth: number
  documentWidth: number
  offenders: Array<{
    tag: string
    className: string
    text: string
    left: number
    right: number
  }>
}

test.describe('iPhone 12 and newer player resolution', () => {
  for (const deviceName of iphoneDeviceNames) {
    test(`${deviceName} can join and use the board without horizontal overflow`, async ({ browser }) => {
      const hostContext = await browser.newContext()
      const playerContext = await browser.newContext({ ...devices[deviceName] })

      try {
        const { host, roomCode } = await createHostRoom(hostContext)
        const player = await playerContext.newPage()

        await player.goto(`/player?room=${roomCode}`)
        await expect(player.getByRole('heading', { name: 'Join room' })).toBeVisible()
        await expectNoHorizontalOverflow(player)

        await player.getByLabel('Display name').fill(deviceName)
        await player.getByRole('button', { name: /join room/i }).click()
        await expect(player.getByText(`Room ${roomCode}`)).toBeVisible()
        await expectNoHorizontalOverflow(player)

        await host.getByRole('button', { name: 'Start game' }).click()
        await expect(player.getByRole('heading', { name: 'Board control' })).toBeVisible({ timeout: 12_000 })
        await expect(player.getByRole('button', { name: 'Select clue' }).first()).toBeVisible()
        await expectNoHorizontalOverflow(player)
      } finally {
        await playerContext.close()
        await hostContext.close()
      }
    })
  }
})

async function createHostRoom(hostContext: BrowserContext) {
  const host = await hostContext.newPage()
  await host.goto('/')
  await expect(host.getByRole('heading', { name: 'Peds Cardio Quiz Board' })).toBeVisible()
  await host.getByRole('button', { name: 'Create room' }).click()
  await expect.poll(() => new URL(host.url()).searchParams.get('room')).toBeTruthy()

  const roomCode = new URL(host.url()).searchParams.get('room')
  expect(roomCode).toBeTruthy()
  await expect(host.getByText(`Room ${roomCode}`)).toBeVisible()

  return { host, roomCode: roomCode as string }
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = (await page.evaluate(`(() => {
    const viewportWidth = document.documentElement.clientWidth
    const documentWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)
    const offenders = Array.from(document.body.querySelectorAll('*'))
      .map((element) => {
        const rect = element.getBoundingClientRect()
        return {
          tag: element.tagName.toLowerCase(),
          className: element.className.toString(),
          text: (element.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
        }
      })
      .filter((entry) => entry.left < -1 || entry.right > viewportWidth + 1)
      .slice(0, 5)

    return { viewportWidth, documentWidth, offenders }
  })()`)) as OverflowReport

  expect(overflow.documentWidth, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.viewportWidth + 1)
  expect(overflow.offenders, JSON.stringify(overflow)).toHaveLength(0)
}
