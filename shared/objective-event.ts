/** Accept the nested and top-level payloads used by Tavus objective app messages. */
export function objectiveEvent(raw: unknown, conversationId: string) {
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== 'object') return null;
  const event = value as Record<string, unknown>;
  if (event.event_type !== 'conversation.objective.activated' && event.event_type !== 'conversation.objective.completed') return null;
  if (event.conversation_id && event.conversation_id !== conversationId) return null;
  const props = event.properties && typeof event.properties === 'object' ? event.properties as Record<string, unknown> : {};
  const name = props.objective_name ?? event.objective_name;
  if (typeof name !== 'string' || !name.trim()) return null;
  const output = props.output_variables ?? event.output_variables;
  return {
    type: event.event_type.endsWith('.completed') ? 'objective_completed' : 'objective_activated',
    detail: { objective_name: name, output_variables: output && typeof output === 'object' && !Array.isArray(output) ? output : {} },
  };
}
