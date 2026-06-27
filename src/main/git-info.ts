import { execFile } from 'node:child_process'

// 读 cwd 所在仓库的当前分支；detached HEAD 返回短 sha（带括号）；非仓库 / 出错返回 null。
export function readGitBranch(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (!cwd || typeof cwd !== 'string') {
      resolve(null)
      return
    }
    execFile(
      'git',
      ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { timeout: 4000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve(null)
          return
        }
        const b = stdout.trim()
        if (!b) {
          resolve(null)
          return
        }
        if (b !== 'HEAD') {
          resolve(b)
          return
        }
        // detached：取短 sha
        execFile(
          'git',
          ['-C', cwd, 'rev-parse', '--short', 'HEAD'],
          { timeout: 4000, windowsHide: true },
          (e2, o2) => resolve(e2 ? null : `(${o2.trim()})`)
        )
      }
    )
  })
}
