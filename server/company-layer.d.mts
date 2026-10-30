import type { IncomingMessage, ServerResponse } from "node:http";

export interface ProjectFocus {
  name: string;
  section?: string;
  archivedAt?: string;
  members: readonly { botId: string }[];
  chats: readonly { botId: string; threadId: string }[];
}
export interface CompanyStore { load(): { projects: readonly ProjectFocus[] }; save(state: unknown): void }
export function createStore(path: string): CompanyStore;
export function syncWithDepartments(store: CompanyStore, native?: unknown): unknown;
export function companyLayerPrompt(store: CompanyStore, botId: string, threadId?: string, sectionHint?: string): string;
export function proposeTaskFromBot(store: CompanyStore, input: Record<string, unknown>): unknown;
export function decideTaskAsChief(store: CompanyStore, input: Record<string, unknown>): unknown;
export const STALE_TASK_DAYS: number;
export interface CompanyBoardTask { stale?: boolean; staleDays?: number; staleSince?: string; status?: string; [key: string]: unknown }
export interface CompanyBoardProject { tasks: readonly CompanyBoardTask[]; staleCount?: number; [key: string]: unknown }
export interface CompanyBoardState { projects: readonly CompanyBoardProject[]; [key: string]: unknown }
/** Derived, never persisted: marks open tasks whose conversation and record are both quiet. */
export function markStaleTasks(state: CompanyBoardState, options?: {
  staleDays?: number; now?: number; activity?: (threadId: string) => number | undefined;
}): CompanyBoardState & { projects: readonly (CompanyBoardProject & { staleCount: number })[]; staleDays: number };
export interface CompanyHandleContext {
  method: string; path: string; auth?: { scopes?: readonly string[] };
  native?: unknown;
  /** Epoch ms of the newest message in a thread, when the native store knows it. */
  threadActivity?(threadId: string): number | undefined;
  /** Days without activity before an open task is marked as stalled. */
  staleDays?: number;
  ensureSection?(section: string, botIds: string[]): void;
  botExists?(botId: string): boolean;
  threadExists?(id: string): boolean;
  canLinkThread?(botId: string, threadId: string): boolean;
}
export function companyHandle(req: IncomingMessage, res: ServerResponse, ctx: CompanyHandleContext, store: CompanyStore, botsFile: string): Promise<boolean>;
