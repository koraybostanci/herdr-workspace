import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { testTmpRoot } from './tmp-root.mjs';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const runtime=new URL('./herdr-runtime.mjs',import.meta.url).href;
const stores=new Map();
export function modStorage(directory) {
  const key=resolve(directory);
  if(!stores.has(key)) {
    const values=new Map();
    stores.set(key,{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k),clear:()=>values.clear()});
  }
  return stores.get(key);
}
globalThis.__herdrTestStorage=modStorage;
export async function loadHerdrMod(directory,entry='main.js') {
  const root=resolve(directory),cache=new Map();
  const output=await mkdtemp(join(testTmpRoot(),'herdr-mod-loader-'));
  async function compile(path) {
    if(cache.has(path))return cache.get(path);
    let source=await readFile(path,'utf8');
    const imports=[...source.matchAll(/\bfrom\s+["']([^"']+)["']/g)];
    for(const match of imports) {
      const specifier=match[1];let target;
      if(['herdr','gpui-kit','gpui-base'].includes(specifier))target=runtime;
      else if(specifier.startsWith('.'))target=await compile(resolve(dirname(path),specifier));
      else target=specifier;
      source=source.replace(match[0],`from ${JSON.stringify(target)}`);
    }
    source=`const localStorage = globalThis.__herdrTestStorage(${JSON.stringify(root)});\n`+source;
    const target=resolve(output,createHash('sha256').update(path).digest('hex').slice(0,12)+'.mjs');
    await writeFile(target,source,{mode:0o600});
    const url=pathToFileURL(target).href;cache.set(path,url);return url;
  }
  try {return await import(await compile(resolve(root,entry)));}
  finally {await rm(output,{recursive:true,force:true});}
}
