// Conversational objectives describe shopper evidence. Application state alone
// controls publication, per-change feedback completion, and ending the call.
export const interviewObjectives = [
  {
    objective_name: 'capture_shopping_goal',
    objective_prompt: 'The shopper has stated the clothing item they want and a criterion that would make it right for them. Extract their own words; do not infer a goal from clicks.',
    confirmation_mode: 'auto',
    modality: 'verbal',
    output_variables: ['shopping_item', 'shopping_criteria'],
    next_required_objective: 'understand_shopping_obstacle',
  },
  {
    objective_name: 'understand_shopping_obstacle',
    objective_prompt: 'Complete when the shopper has explained a specific first-journey difficulty and their desired resolution, OR when application context confirms the first journey has ended without a confirmed difficulty and remedy. In the latter case, record unavailable rather than inventing friction or asking extra obstacle questions. Extract only explanations and remedies the shopper actually stated. Expressions, option switching, a five-second idle event, or an interviewer hypothesis alone are not confirmation of an obstacle. This objective must not hold up the post-journey debrief when the shopper encounters no friction.',
    confirmation_mode: 'auto',
    modality: 'verbal',
    output_variables: ['shopping_obstacle', 'shopper_explanation', 'suggested_resolution'],
    next_required_objective: 'collect_overall_experience',
  },
  {
    objective_name: 'collect_overall_experience',
    objective_prompt: 'Only after application context confirms the first journey ended, the shopper has answered the overall-experience question or explicitly declined to answer it. A short answer or decline is sufficient; do not press for detail or repeat an answered question. Extract the actual answer or decline. The interviewer merely asking the question, a playback notification, silence, or website publication does not complete this objective. Do not count a response from the shopping journey before the overall question.',
    confirmation_mode: 'auto',
    modality: 'verbal',
    output_variables: ['overall_experience_response'],
    next_required_objective: 'discuss_knowledge_base_concern',
  },
  {
    objective_name: 'discuss_knowledge_base_concern',
    objective_prompt: 'After the overall-experience response or decline, the shopper has answered whether the rank 1 concern retrieved from the attached Tavus knowledge-base CSV applied to them, or explicitly declined to answer that question. A brief yes, no, or decline is sufficient. Extract the actual concern and response. Do not infer their answer from earlier browsing, the interviewer asking, a playback notification, silence, or website publication. If application context or the interviewer explicitly says retrieval is unavailable, this milestone may be skipped without inventing past-user research. Do not repeat an answered question. Completion is conversational evidence only; publication still requires backend confirmation.',
    confirmation_mode: 'auto',
    modality: 'verbal',
    output_variables: ['knowledge_base_concern', 'knowledge_base_response'],
    next_required_objective: 'collect_retest_reaction',
  },
  {
    objective_name: 'collect_retest_reaction',
    objective_prompt: 'After the application confirms publication and the shopper reloads, they have reacted to every actual published change identified in application context, or explicitly declined to try a change. Extract each change and its separate reaction or decline. Do not infer that particular features were changed. Feedback on one of two changes is incomplete. This objective is evidence only and does not authorize ending the call.',
    confirmation_mode: 'auto',
    modality: 'verbal',
    output_variables: ['change_reactions', 'remaining_difficulty'],
  },
] as const;
