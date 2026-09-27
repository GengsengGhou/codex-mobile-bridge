export async function readSecret(prompt = 'Secret: ') {
  if (!process.stdin.isTTY) {
    const chunks = []; let size = 0;
    for await (const chunk of process.stdin) { size += chunk.length; if (size > 4096) throw new Error('Secret input too long.'); chunks.push(chunk); }
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  }
  process.stdout.write(prompt);
  return new Promise((resolve, reject) => {
    let input = '';
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
    const finish = error => {
      process.stdin.off('data', receive); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n');
      error ? reject(error) : resolve(input);
    };
    const receive = chunk => {
      for (const char of chunk) {
        if (char === '\u0003') { finish(new Error('Cancelled.')); return; }
        if (char === '\r' || char === '\n') { finish(); return; }
        if (char === '\u007f' || char === '\b') input = input.slice(0, -1);
        else if (char >= ' ') input += char;
        if (Buffer.byteLength(input) > 4096) { finish(new Error('Secret input too long.')); return; }
      }
    };
    process.stdin.on('data', receive);
  });
}
