import { createInterface } from 'node:readline';
process.stdout.write('Agent ready\n');
for await (const line of createInterface({input:process.stdin})) process.stdout.write('received: '+line+'\n');
