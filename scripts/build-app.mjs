import {build} from 'esbuild';
import {mkdir,copyFile,rm,readFile,writeFile} from 'node:fs/promises';
// Publish only this explicit list: never copy a repository, private/, or keypairs.
await rm('dist',{recursive:true,force:true});
await mkdir('dist/devnet',{recursive:true});
await mkdir('dist/mock',{recursive:true});
await mkdir('dist/v3',{recursive:true});
await build({entryPoints:['mainstream/main.mjs'],bundle:true,outfile:'dist/v3/main.js',platform:'browser',target:['es2022'],define:{global:'globalThis'},minify:true});
await copyFile('mainstream/style.css','dist/v3/style.css');
for(const route of ['','user','signup','shop','support','account','communities','communities/new']){await mkdir(`dist/${route}`,{recursive:true});await copyFile('mainstream/index.html',`dist/${route}/index.html`);}
await build({entryPoints:['app/main.mjs'],bundle:true,outfile:'dist/app.js',platform:'browser',target:['es2022'],define:{global:'globalThis'},sourcemap:false,minify:true});
for(const [source,destination] of [
 ['app/index.html','dist/devnet/index.html'],
 ['app/style.css','dist/devnet/style.css'],['dist/app.js','dist/devnet/app.js'],
 ['deployments/devnet.json','dist/devnet/deployment.json'],
 ['model.js','dist/mock/model.js'],
 ['LICENSE','dist/LICENSE'],
]) await copyFile(source,destination);
const mock=(await readFile('index.html','utf8'))
 .replace('href="app/index.html"','href="/devnet/"')
 .replace('href="README.md"','href="https://github.com/kentaroid-bot/emergency-straw-protocol/blob/main/README.md"')
 .replace('href="DESIGN.md"','href="https://github.com/kentaroid-bot/emergency-straw-protocol/blob/main/DESIGN.md"');
await writeFile('dist/mock/index.html',mock);
console.log('Built dist/: Devnet app + offline mock; explicit public files only, no CDN');
