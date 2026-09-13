#!/usr/bin/env node
// Offline integration double: no provider/API access and no conversation creation.
if(process.argv[2]!=='resume') process.exit(2);
console.log(JSON.stringify({fixture:'offline-codex-resume',conversationId:process.argv.at(-1),cwd:process.cwd()}));
setInterval(()=>{},1000);
