#!/usr/bin/env node
import { resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPlanRuntime } from '../src/plans/runtime.mjs';

async function input() {
  const chunks=[];let size=0;
  for await(const chunk of process.stdin){size+=chunk.length;if(size>1048576)throw Error('request-too-large');chunks.push(chunk);}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
}
function option(args,name) {
  const index=args.indexOf(name);if(index<0)return null;
  const value=args[index+1];
  if(typeof value!=='string'||!isAbsolute(value)||/[\x00-\x1f\x7f]/.test(value))throw Error('invalid-runtime-path');
  return value;
}
export async function main(args=process.argv.slice(2),runtime=null) {
  runtime??=createPlanRuntime({...process.env,HERDR_APP_HOME:option(args,'--app-home')??process.env.HERDR_APP_HOME,
    HERDR_METADATA_STATE_DIR:option(args,'--state-root')??process.env.HERDR_METADATA_STATE_DIR});
  try {
    let result;
    if(args[0]==='prepare')result={ok:true,value:await runtime.bridge.prepare(args[args.indexOf('--operation')+1])};
    else if(args[0]==='apply')result=await runtime.bridge.apply(args[args.indexOf('--id')+1]);
    else if(args[0]==='rpc')result=await runtime.bridge.handle(await input());
    else result=await runtime.bridge.handle({op:args[0],payload:{}});
    process.stdout.write(JSON.stringify(result)+'\n');return result.ok?0:1;
  } finally {runtime.db.close();}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  try {process.exitCode=await main();}
  catch {process.stdout.write(JSON.stringify({ok:false,reason:'plan-helper-unavailable'})+'\n');process.exitCode=1;}
}
