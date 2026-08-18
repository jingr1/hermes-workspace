import { describe, expect, it } from 'vitest'
import { isPortInUse } from './gateway-port-owner'

describe('gateway-port-owner', () => {
  it('reports unused ports as free', () => {
    expect(isPortInUse(1)).toBe(false)
  })
})
