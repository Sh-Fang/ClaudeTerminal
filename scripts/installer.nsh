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

!macro customInstall
  ; ─ Directory (在文件夹上右键) ────────────────────────────
  WriteRegStr HKCU "Software\Classes\Directory\shell\ClaudeTerminal" "" "在此处打开 Claude Terminal"
  WriteRegStr HKCU "Software\Classes\Directory\shell\ClaudeTerminal" "Icon" '"$INSTDIR\${PRODUCT_FILENAME}.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\shell\ClaudeTerminal\command" "" '"$INSTDIR\${PRODUCT_FILENAME}.exe" --open-here "%V"'

  ; ─ Directory\Background (在文件夹里的空白处右键) ────────
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\ClaudeTerminal" "" "在此处打开 Claude Terminal"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\ClaudeTerminal" "Icon" '"$INSTDIR\${PRODUCT_FILENAME}.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\ClaudeTerminal\command" "" '"$INSTDIR\${PRODUCT_FILENAME}.exe" --open-here "%V"'

  ; ─ Drive (磁盘右键) ─────────────────────────────────────
  WriteRegStr HKCU "Software\Classes\Drive\shell\ClaudeTerminal" "" "在此处打开 Claude Terminal"
  WriteRegStr HKCU "Software\Classes\Drive\shell\ClaudeTerminal" "Icon" '"$INSTDIR\${PRODUCT_FILENAME}.exe",0'
  WriteRegStr HKCU "Software\Classes\Drive\shell\ClaudeTerminal\command" "" '"$INSTDIR\${PRODUCT_FILENAME}.exe" --open-here "%V"'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Directory\shell\ClaudeTerminal"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\ClaudeTerminal"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\ClaudeTerminal"
!macroend
