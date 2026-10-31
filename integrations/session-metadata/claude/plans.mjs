import { extractPlanWrites } from '../src/plans/evidence.mjs';

export function createClaudePlanObserver({rpc,sdk,scope}) {
  return {
    async observe(input) {
      if(!input || input.agent_id || typeof input.session_id!=='string')return;
      const session={...scope,harness:'claude',id:input.session_id};
      if(input.hook_event_name==='SessionEnd'){await rpc({op:'owner-end',payload:{session}});return;}
      const response=input.tool_response??{};
      const writes=input.hook_event_name==='PostToolUse'?extractPlanWrites({eventId:input.tool_use_id,tool:input.tool_name,input:input.tool_input,
        failed:Boolean(response.is_error||response.interrupted||response.exit_code&&response.exit_code!==0)},'claude'):[];
      if(!['SessionStart','UserPromptSubmit'].includes(input.hook_event_name)&&!writes.length)return;
      // Reserve before the SDK await: late startup completion cannot reclaim a newer generation.
      const reservation=await rpc({op:'owner-reserve',payload:{session,expectedGeneration:null}});
      if(!reservation.ok||!reservation.value)return;
      const access=typeof sdk==='function'?await sdk():sdk;
      const info=await access.getSessionInfo(session.id,input.cwd?{dir:input.cwd}:{});
      if(info?.sessionId!==session.id)return;
      const committed=await rpc({op:'owner-commit',payload:{reservation:reservation.value,session}});
      if(committed.ok&&committed.value)for(const artifact of writes)await rpc({op:'register',payload:{...artifact,session,proof:committed.value}});
    },
  };
}
