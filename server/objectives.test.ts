import assert from 'node:assert/strict';
import { test } from 'node:test';
import { interviewObjectives } from './objectives.js';

test('Tavus objectives have one root and each remaining objective has exactly one parent', () => {
  const objectives: readonly {
    objective_name: string;
    next_required_objective?: string;
    next_conditional_objectives?: Record<string, string>;
  }[] = interviewObjectives;
  const names = objectives.map(objective => objective.objective_name);
  assert.equal(new Set(names).size, names.length, 'Objective names must be unique');
  const parents = new Map(names.map(name => [name, 0]));
  const edges = new Map<string, string[]>();
  for (const objective of objectives) {
    assert.ok(!(objective.next_required_objective && objective.next_conditional_objectives),
      'Required and conditional successors are mutually exclusive');
    const successors = objective.next_required_objective
      ? [objective.next_required_objective]
      : Object.keys(objective.next_conditional_objectives ?? {});
    edges.set(objective.objective_name, successors);
    for (const successor of successors) {
      assert.ok(parents.has(successor), `Unknown successor: ${successor}`);
      parents.set(successor, parents.get(successor)! + 1);
    }
  }
  const roots = names.filter(name => parents.get(name) === 0);
  assert.deepEqual(roots, ['capture_shopping_goal']);
  for (const name of names.filter(name => !roots.includes(name))) {
    assert.equal(parents.get(name), 1, `${name} must have exactly one parent`);
  }
  const visited = new Set<string>();
  function visit(name: string) {
    assert.ok(!visited.has(name), `Cycle or duplicate path to ${name}`);
    visited.add(name);
    for (const successor of edges.get(name) ?? []) visit(successor);
  }
  visit(roots[0]);
  assert.equal(visited.size, names.length, 'Every objective must be reachable');
});

test('post-journey milestones precede retry and collect answers rather than playback', () => {
  const byName = new Map<string, { objective_prompt: string; next_required_objective?: string }>(interviewObjectives.map(objective => [objective.objective_name, objective]));
  const overall = byName.get('collect_overall_experience')!;
  const knowledge = byName.get('discuss_knowledge_base_concern')!;
  assert.equal(overall.next_required_objective, 'discuss_knowledge_base_concern');
  assert.equal(knowledge.next_required_objective, 'collect_retest_reaction');
  for (const objective of [overall, knowledge]) {
    assert.match(objective.objective_prompt, /declined/);
    assert.match(objective.objective_prompt, /playback notification/);
    assert.match(objective.objective_prompt, /answered/);
  }
  assert.match(byName.get('understand_shopping_obstacle')!.objective_prompt, /first journey has ended without a confirmed difficulty/);
  assert.match(knowledge.objective_prompt, /retrieval is unavailable/);
});
