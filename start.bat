@echo off
cd /d "%~dp0"
echo Pohjapiirustus-skanneri: http://localhost:7070
python -m http.server 7070
