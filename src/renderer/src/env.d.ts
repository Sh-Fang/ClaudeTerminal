// 样式副作用 import（如 @xterm/xterm/css/xterm.css）的模块声明：
// vite 在构建期处理 CSS，TS 只需要认得这个模块形态即可。
declare module '*.css'
