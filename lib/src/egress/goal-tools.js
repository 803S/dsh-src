import {gateError} from './plan.js';
// AgentTeams children may be absent from the native registry's parent edges
// while their durable session header still identifies them as delegated.
// Such a child must not turn a delegated job into an autonomous root goal.
export function guardGoalTool(name,session){
 if((name==='create_goal'||name==='update_goal')&&session?.header?.parentSession)throw gateError('DELEGATED_GOAL_MUTATION');
}
