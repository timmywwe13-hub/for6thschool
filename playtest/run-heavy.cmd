@echo off
cd /d C:\Users\Conner\Downloads\22
node cdp-test.js maprotation > playtest\maprotation.log 2>&1
node cdp-test.js playtest > playtest\playtest.log 2>&1
node cdp-test.js friendsnet > playtest\friendsnet.log 2>&1
node cdp-test.js fullmatch > playtest\fullmatch.log 2>&1
