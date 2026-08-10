// 验证：@lydell/node-pty 预编译二进制能加载并真实驱动 pwsh（无需 C++ 工具链）
// 运行：npm run smoke:pty
const os = require('os');
const pty = require('@lydell/node-pty');

const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';

console.log('[smoke] node', process.version, 'platform', process.platform, process.arch);

const p = pty.spawn(PWSH, ['-NoLogo', '-NoProfile'], {
  name: 'xterm-256color',
  cols: 80,
  rows: 24,
  cwd: os.homedir(),
  env: process.env,
  useConpty: true, // 强制 ConPTY
});

let buf = '';
p.onData((d) => {
  buf += d;
  process.stdout.write(d);
});

p.onExit(({ exitCode }) => {
  const ok = /PTY-OK-\d+/.test(buf);
  console.log('\n[smoke] pwsh 退出码:', exitCode);
  console.log('[smoke] ConPTY 交互验证:', ok ? '成功 ✅（拿到 pwsh 计算结果，说明伪终端真正打通）' : '未捕获到标记 ❌');
  process.exit(ok && exitCode === 0 ? 0 : 1);
});

// 设 UTF-8 防中文乱码，让 pwsh 算一个值回显后退出
setTimeout(() => {
  p.write('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\r');
  p.write('"PTY-OK-$((6*7))  中文OK"\r');
  p.write('exit\r');
}, 600);
