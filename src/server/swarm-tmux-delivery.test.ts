import { describe, expect, it } from 'vitest'

import { buildHermesTmuxTuiCommand } from './swarm-tmux-delivery'

describe('buildHermesTmuxTuiCommand runtime model injection', () => {
  it('injects launch-scoped HERMES_MODEL env without mutating profile config', () => {
    const command = buildHermesTmuxTuiCommand({
      profilePath: '/home/user/.hermes/profiles/developer',
      hermesBin: '/usr/bin/hermes',
      useExec: true,
      runtimeModel: {
        provider: 'moonshot-coding-plan',
        default: 'kimi-for-coding',
      },
    })

    expect(command).toContain("HERMES_MODEL='kimi-for-coding'")
    expect(command).toContain("HERMES_TUI_PROVIDER='moonshot-coding-plan'")
    expect(command).toContain("exec '/usr/bin/hermes' chat --tui")
  })
})
