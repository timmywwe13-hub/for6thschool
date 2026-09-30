@echo off
cd /d C:\Users\Conner\Downloads\22
node cdp-test.js victory > playtest\victory.log 2>&1
node cdp-test.js endgame > playtest\endgame.log 2>&1
node cdp-test.js systems > playtest\systems.log 2>&1
node cdp-test.js lootflow > playtest\lootflow.log 2>&1
node cdp-test.js fullmatch > playtest\fullmatch.log 2>&1
