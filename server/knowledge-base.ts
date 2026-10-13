import fs from 'node:fs';
import path from 'node:path';
import { addEvent, type StudySession } from './state.js';
import { awaitingPostJourneyAnswer } from '../shared/interview-turn.js';

type SampleIssue = { description: string; users: number };

const sampleIssuesFile = path.join(process.cwd(), 'knowledge-base', 'sample-issues.json');

export function getMostCommonSampleIssue() {
  const raw = JSON.parse(fs.readFileSync(sampleIssuesFile, 'utf8')) as unknown;
  if (!Array.isArray(raw)) throw new Error('The sample research knowledge base must be a list of issues.');
  const issues: SampleIssue[] = raw.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Each sample issue must have a description and users count.');
    const record = row as Record<string, unknown>;
    const description = typeof record.description === 'string' ? record.description.trim() : '';
    const users = record.users;
    if (!description || description.length > 300 || !Number.isSafeInteger(users) || Number(users) < 1) {
      throw new Error('Each sample issue needs a short description and a positive whole number of users.');
    }
    return { description, users: Number(users) };
  });
  if (!issues.length) return { available: false, source: 'sample research data', message: 'No sample research issues are available.' };
  issues.sort((a, b) => b.users - a.users || a.description.localeCompare(b.description));
  const first = issues[0];
  return {
    available: true,
    source: 'synthetic demo knowledge-base data',
    description: first.description,
    users: first.users,
    tiedForMostCommon: issues.length > 1 && issues[1].users === first.users,
    guidance: 'Discuss this concern naturally after the shopper answers the overall-experience question. Do not repeat it once answered or treat a yes/no answer alone as repair evidence.',
  };
}

export function prepareSampleIssue(session: StudySession) {
  const existing = session.events.find((event) => event.type === 'sample_issue_lookup');
  if (existing) return existing.detail;
  try {
    const issue = getMostCommonSampleIssue();
    const detail = issue.available
      ? { available: true, description: issue.description, users: issue.users, source: issue.source }
      : { available: false, source: issue.source };
    addEvent(session, 'sample_issue_lookup', detail);
    return detail;
  } catch (error) {
    const detail = { available: false, source: 'synthetic demo knowledge-base data', error: (error as Error).message };
    addEvent(session, 'sample_issue_lookup', detail);
    return detail;
  }
}

export function sampleFollowUpComplete(session: StudySession) {
  if (!session.firstAttemptCompletedAt) return false;
  const lookupIndex = session.events.findIndex((event) => event.type === 'sample_issue_lookup');
  if (lookupIndex < 0) return false;
  const promptIndex = session.events.findIndex((event, index) => index > lookupIndex && event.type === 'sample_question_prompted');
  if (promptIndex < 0) return false;
  if (session.events[lookupIndex].detail.available === false) return !awaitingPostJourneyAnswer(session.events, session.firstAttemptCompletedAt);
  if (session.events[promptIndex].detail.questionAsked !== true) return false;
  const initialAnswerReceived = session.events.some((event, index) => index > promptIndex && event.type === 'utterance' && event.detail.role === 'user');
  return initialAnswerReceived && !awaitingPostJourneyAnswer(session.events, session.firstAttemptCompletedAt);
}
