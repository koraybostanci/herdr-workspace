// Derived paths only. Prompts, file bodies and arbitrary tool output never cross this boundary.
export function extractPlanWrites(event, harness) {
  if (!event || event.failed || !['opencode','claude'].includes(harness) || typeof event.eventId !== 'string'
    || !/^[\w.:-]{1,480}$/.test(event.eventId)) return [];
  const tool=String(event.tool??'').split(/[.:]/).at(-1).toLowerCase(), input=event.input??{};
  const paths=[];
  if (['write','edit','multiedit'].includes(tool)) {
    const path=input.filePath??input.file_path??input.path;
    if (typeof path==='string') paths.push(path);
  }
  if (['patch','apply_patch'].includes(tool)) {
    const patch=input.patchText??input.patch??'';
    if (typeof patch==='string') for (const match of patch.matchAll(/^\*\*\* (?:Add File|Update File|Move to): (.+)$/gm)) paths.push(match[1]);
  }
  return [...new Set(paths)].slice(0,100).filter(path=>/^(?:\/|[A-Za-z]:[\\/])/.test(path) && !/[\x00-\x1f\x7f]/.test(path)
    && /\.(?:md|markdown)$/i.test(path) && /\/(?:docs\/superpowers\/(?:specs|plans)|\.claude\/plans)\//.test(path.replaceAll('\\','/')))
    .map((path,index)=>({path,kind:/\/docs\/superpowers\/specs\//.test(path.replaceAll('\\','/'))?'design':'implementation',source:`${harness}-tool:${event.eventId}:${index}`}));
}
