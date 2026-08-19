import { describe, expect, it } from 'vitest'

import { getCollaborationConsoleAsset } from './console.js'

describe('collaboration console assets', () => {
  it('serves the console shell and static assets with explicit MIME types', () => {
    expect(getCollaborationConsoleAsset('/console')).toMatchObject({ contentType: 'text/html; charset=utf-8' })
    expect(getCollaborationConsoleAsset('/console/')).toEqual(getCollaborationConsoleAsset('/console'))
    expect(getCollaborationConsoleAsset('/console?from=health')).toEqual(getCollaborationConsoleAsset('/console'))
    expect(getCollaborationConsoleAsset('/console/app.css')).toMatchObject({ contentType: 'text/css; charset=utf-8' })
    expect(getCollaborationConsoleAsset('/console/app.js')).toMatchObject({ contentType: 'text/javascript; charset=utf-8' })
    expect(getCollaborationConsoleAsset('/console/missing')).toBeNull()
  })

  it('keeps credentials memory-only and renders untrusted responses as text', () => {
    const html = getCollaborationConsoleAsset('/console')?.body ?? ''
    const script = getCollaborationConsoleAsset('/console/app.js')?.body ?? ''

    expect(html).toContain('type="password"')
    expect(html).toContain('autocomplete="off"')
    expect(script).toContain("const state = { token: ''")
    expect(script).toContain('textContent = text')
    expect(script).toContain("credentials: 'same-origin'")
    expect(script).not.toMatch(/localStorage|sessionStorage|innerHTML|outerHTML|eval\s*\(|new Function/u)
    expect(html).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{16,}/u)
  })

  it('uses only canonical same-origin commands and supplies write idempotency headers', () => {
    const script = getCollaborationConsoleAsset('/console/app.js')?.body ?? ''
    const expectedCommands = [
      'credential.revoke_current',
      'user.get',
      'project.create',
      'project.get',
      'project.capability_directory.get',
      'project.transition',
      'task.create',
      'task.get',
      'task.transition',
      'task.retry',
      'inbox.pull',
      'inbox.ack',
      'project_record.get',
      'project_record.accept',
      'resource.get'
    ]

    expect(script).toContain("consolePath.replace(/\\/console\\/$/u, '/v1/commands')")
    expect(script).toContain("headers['Idempotency-Key'] = command.idempotencyKey")
    expect(script).toContain("type: 'rest.error'")
    expect(script).toContain('error.currentRevision')
    for (const command of expectedCommands) expect(script).toContain(command)
    expect(script).not.toContain('task.list')
    expect(script).not.toContain('project.list')
    expect(script).not.toContain('human.answer')
  })

  it('contains no B, C, D, or E module execution surfaces', () => {
    const html = getCollaborationConsoleAsset('/console')?.body ?? ''
    expect(html).toContain('不实现 Coordinator 推理、Zulip 客户端或 OpenContent 正文')
    expect(html).not.toMatch(/运行 Agent|上传正文|Slurm|GPU 调度/u)
  })
})
