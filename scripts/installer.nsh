; Claude Terminal · NSIS 自定义脚本
; 在 Windows 资源管理器里注册"在此处打开 Claude Terminal"右键菜单。
;
; 覆盖三个入口：
;   1) 目录项右键（在文件夹上点右键）
;   2) 目录背景右键（在文件夹里空白处点右键）  → 用 %V 拿当前目录
;   3) 磁盘根右键
;
; 只写 HKCU（当前用户），不需要管理员，也不影响其他用户；卸载时同步删除。
; command 里的 exe 用 $INSTDIR\${PRODUCT_FILENAME}.exe —— electron-builder 里
; productName 是 "Claude Terminal"，nsis 会把可执行名拼成同名。
;
; 参数用等号形式 --open-here="%V" 而非空格 --open-here "%V"：app 已在运行时右键会走
; Electron 单实例的 second-instance，Chromium 会重排该进程 argv（switch 提前、注入自己的
; flag、裸路径挪到末尾），空格形式会让 --open-here 与路径被拆散、解析不到（表现为“app
; 开着时右键无反应”）。等号形式把路径绑进 switch 值，Chromium 当整体保留、不拆散。
; 兜底见 main/index.ts 的 parseOpenHere（即便存量注册表还是空格形式也能捞回路径）。
; 磁盘根 %V=D:\ 另有一坑：命令行 "D:\" 的 \" 会被转义、路径坏成 D:"，这在 NSIS 层无解
; （VSCode 的 "%V" 同样中招），由 parseOpenHere 的 normalizeArgPath 在接收端清洗回 D:\ 。

!macro customInstall
  ; ─ Directory (在文件夹上右键) ────────────────────────────
  WriteRegStr HKCU "Software\Classes\Directory\shell\ClaudeTerminal" "" "在此处打开 Claude Terminal"
  WriteRegStr HKCU "Software\Classes\Directory\shell\ClaudeTerminal" "Icon" '"$INSTDIR\${PRODUCT_FILENAME}.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\shell\ClaudeTerminal\command" "" '"$INSTDIR\${PRODUCT_FILENAME}.exe" --open-here="%V"'

  ; ─ Directory\Background (在文件夹里的空白处右键) ────────
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\ClaudeTerminal" "" "在此处打开 Claude Terminal"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\ClaudeTerminal" "Icon" '"$INSTDIR\${PRODUCT_FILENAME}.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\ClaudeTerminal\command" "" '"$INSTDIR\${PRODUCT_FILENAME}.exe" --open-here="%V"'

  ; ─ Drive (磁盘右键) ─────────────────────────────────────
  WriteRegStr HKCU "Software\Classes\Drive\shell\ClaudeTerminal" "" "在此处打开 Claude Terminal"
  WriteRegStr HKCU "Software\Classes\Drive\shell\ClaudeTerminal" "Icon" '"$INSTDIR\${PRODUCT_FILENAME}.exe",0'
  WriteRegStr HKCU "Software\Classes\Drive\shell\ClaudeTerminal\command" "" '"$INSTDIR\${PRODUCT_FILENAME}.exe" --open-here="%V"'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Directory\shell\ClaudeTerminal"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\ClaudeTerminal"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\ClaudeTerminal"
!macroend
