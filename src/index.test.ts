import type { API } from 'homebridge'

import { describe, expect, it, vi } from 'vitest'

import registerPlatform from './index.js'
import { GenieAladdinConnectHomebridgePlatform } from './platform.js'
import { PLATFORM_NAME } from './settings.js'

describe('registerPlatform', () => {
  it('should register the platform with Homebridge', () => {
    const api = {
      registerPlatform: vi.fn(),
    } as unknown as API

    registerPlatform(api)

    expect(api.registerPlatform).toHaveBeenCalledWith(PLATFORM_NAME, GenieAladdinConnectHomebridgePlatform)
  })
})
