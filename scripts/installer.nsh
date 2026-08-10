; NSIS 自定义脚本：注册"在此处打开 Claude Terminal"右键菜单（目录 / 目录背景 / 磁盘根）。
; 只写 HKCU，无需管理员，卸载时同步删除。
; 必须用等号形式 --open-here="%V"：空格形式会被 Chromium second-instance 的 argv 重排拆散。
; 磁盘根 "D:\" 的 \" 转义坑在 NSIS 层无解，由主进程 parseOpenHere 在接收端清洗。

!macro customInstall
  ; 在文件夹上右键
  WriteRegStr HKCU "Software\Classes\Directory\shell\ClaudeTerminal" "" "在此处打开 Claude Terminal"
  WriteRegStr HKCU "Software\Classes\Directory\shell\ClaudeTerminal" "Icon" '"$INSTDIR\${PRODUCT_FILENAME}.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\shell\ClaudeTerminal\command" "" '"$INSTDIR\${PRODUCT_FILENAME}.exe" --open-here="%V"'

  ; 在文件夹空白处右键
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\ClaudeTerminal" "" "在此处打开 Claude Terminal"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\ClaudeTerminal" "Icon" '"$INSTDIR\${PRODUCT_FILENAME}.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\ClaudeTerminal\command" "" '"$INSTDIR\${PRODUCT_FILENAME}.exe" --open-here="%V"'

  ; 磁盘根右键
  WriteRegStr HKCU "Software\Classes\Drive\shell\ClaudeTerminal" "" "在此处打开 Claude Terminal"
  WriteRegStr HKCU "Software\Classes\Drive\shell\ClaudeTerminal" "Icon" '"$INSTDIR\${PRODUCT_FILENAME}.exe",0'
  WriteRegStr HKCU "Software\Classes\Drive\shell\ClaudeTerminal\command" "" '"$INSTDIR\${PRODUCT_FILENAME}.exe" --open-here="%V"'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Directory\shell\ClaudeTerminal"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\ClaudeTerminal"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\ClaudeTerminal"
!macroend
