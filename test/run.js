// Roda todos os testes desta pasta e agrega o resultado.
// Sem dependências: `bun test/run.js`.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

let failed = 0;

for (const file of files) {
  console.log(`\n===== ${file} =====`);
  const result = spawnSync(process.execPath, [path.join(dir, file)], {
    stdio: 'inherit',
    cwd: dir
  });
  if (result.status !== 0) failed++;
}

console.log(
  failed
    ? `\n${failed} de ${files.length} arquivo(s) de teste falharam`
    : `\n${files.length} arquivo(s) de teste, todos passaram`
);
process.exit(failed ? 1 : 0);
