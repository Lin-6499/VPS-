import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
for (const directory of ['src','public','scripts','test']) {
  for (const name of readdirSync(directory).filter(name=>name.endsWith('.js'))) {
    const result=spawnSync(process.execPath,['--check',`${directory}/${name}`],{stdio:'inherit'});
    if (result.status!==0) process.exit(result.status||1);
  }
}
console.log('All JavaScript syntax checks passed.');
