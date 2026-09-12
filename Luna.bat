@echo off
rem Luna - открыть панель управления в браузере.
rem При необходимости молча поднимает фонового смотрителя (без окна консоли).
wscript //B "%~dp0tools\start-supervisor.vbs"
timeout /t 1 /nobreak >nul
start "" http://127.0.0.1:8787
