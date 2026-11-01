// Host-independent repository identity, shared byte-for-byte with the native mod.
export function githubRepo(value) {
  const match=typeof value==='string'&&value.trim().match(/^(?:git@github\.com:|https:\/\/github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return match?{host:'github.com',owner:match[1],name:match[2]}:null;
}
export async function resolveGithubRepo(value,execute,options={}) {
  const direct=githubRepo(value);if(direct)return direct;
  const alias=typeof value==='string'&&value.trim().match(/^git@([a-z0-9][a-z0-9._-]*):([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  if(!alias)return null;
  try {
    const result=await execute('ssh',['-G',`git@${alias[1]}`],options);
    const hosts=result.code===0?result.stdout.split(/\r?\n/).filter(line=>/^hostname\s/i.test(line)):[];
    if(hosts.length!==1||hosts[0].trim().toLowerCase()!=='hostname github.com')return null;
    return {host:'github.com',owner:alias[2],name:alias[3]};
  } catch {return null;}
}
