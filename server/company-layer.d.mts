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
export function companyHandle(req: IncomingMessage, res: ServerResponse, ctx: {
  method: string; path: string; auth?: { scopes?: readonly string[] };
  native?: unknown;
  ensureSection?(section: string, botIds: string[]): void;
  botExists?(botId: string): boolean;
  threadExists?(threadId: string): boolean;
  canLinkThread?(botId: string, threadId: string): boolean;
}, store: CompanyStore, botsFile: string): Promise<boolean>;
