// 在 Electron 主进程的 ABI 下验证 @lydell/node-pty 预编译二进制能加载并驱动 pwsh。
// Windows 上 Electron 的 console 不一定回显到终端，所以把结果写到文件再由外部读取。
// 运行：electron scripts/electron-smoke.js  （结果写到项目根 .smoke-electron.json）
const { app } = require('electron');
const os = require('os');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', '.smoke-electron.json');
const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

function finish(obj) {
  try { fs.writeFileSync(OUT, JSON.stringify(obj, null, 2)); } catch (e) {}
  app.exit(obj.ok ? 0 : 1);
}

app.whenReady().then(() => {
  const info = {
    runtime: 'electron',
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    napi: process.versions.napi,        // N-API 版本，存在即 N-API 运行时
    modules: process.versions.modules,  // V8 module ABI（Electron 与 Node 不同）
    platform: process.platform,
    arch: process.arch,
  };

  let pty;
  try {
    pty = require('@lydell/node-pty');   // 关键：在 Electron ABI 下加载原生二进制
  } catch (e) {
    return finish({ ok: false, stage: 'require', error: String(e && e.stack || e), info });
  }

  let buf = '';
  let p;
  try {
    p = pty.spawn(PWSH, ['-NoLogo', '-NoProfile'], {
      name: 'xterm-256color', cols: 80, rows: 24, cwd: os.homedir(), env: process.env, useConpty: true,
    });
  } catch (e) {
    return finish({ ok: false, stage: 'spawn', error: String(e && e.stack || e), info });
  }

  const safety = setTimeout(() => finish({ ok: false, stage: 'timeout', info, sample: strip(buf).slice(-400) }), 9000);

  p.onData((d) => { buf += d; });
  p.onExit(({ exitCode }) => {
    clearTimeout(safety);
    const ok = /PTY-OK-42/.test(buf);
    const sample = strip(buf).split('\n').map(s => s.trim()).filter(s => /PTY-OK|中文/.test(s)).slice(0, 3);
    finish({ ok, stage: 'done', exitCode, info, sample });
  });

  setTimeout(() => {
    p.write('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\r');
    p.write('"PTY-OK-$((6*7))  中文OK"\r');
    p.write('exit\r');
  }, 600);
});

// 不开窗口；不要因 window-all-closed 提前退出（本就没开窗，事件不会触发，这里仅兜底）
app.on('window-all-closed', () => {});
