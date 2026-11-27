import { appendFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

// A real raw terminal input loop: pasted newlines belong to the draft, while a
// separate Return submits it. Splits UTF-8 and escape sequences across chunks.
const output = process.argv[2];
if (!process.stdin.isTTY) throw new Error('Fixture requires a PTY');
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write('\x1b[?2004hTUI ready\r\n');
let input = '', draft = '', pasting = false;
const decoder = new StringDecoder('utf8');
process.stdin.on('data', bytes => {
  input += decoder.write(bytes);
  while (input) {
    if ('\x1b[200~'.startsWith(input) || '\x1b[201~'.startsWith(input)) {
      if (input.length < 6) return;
    }
    if (input.startsWith('\x1b[200~')) { pasting = true; input = input.slice(6); continue; }
    if (input.startsWith('\x1b[201~')) { pasting = false; input = input.slice(6); continue; }
    const char = input[0]; input = input.slice(1);
    if (char === '\x03') { draft = ''; continue; }
    if (!pasting && (char === '\r' || char === '\n')) {
      appendFileSync(output, JSON.stringify({ text: draft }) + '\n');
      process.stdout.write('submitted\r\n'); draft = '';
    } else draft += char;
  }
});
