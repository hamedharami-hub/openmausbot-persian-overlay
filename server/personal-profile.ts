import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import type { ModelFavorite } from "../shared/model-favorites.ts";

export const PERSONAL_PROFILE_MAX_CHARS = 24_000;
export const PERSONAL_PROFILE_MAX_NAME_CHARS = 120;
export const PERSONAL_MODEL_FAVORITES_MAX = 500;
export const PERSONAL_MODEL_FAVORITE_ID_MAX_CHARS = 512;
export const PERSONAL_SIDEBAR_FAVORITES_MAX = 500;
const PERSON_KEY = /^p_[A-Za-z0-9_-]{22}$/;
const MAX_PROFILES = 2_000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;

export interface PersonalProfile {
  name?: string;
  aboutMe?: string;
  modelFavorites?: PersonalModelFavorite[];
  sidebarFavorites?: string[];
  updatedAt: number;
}

export type PersonalModelFavorite = ModelFavorite;

interface ProfileFile {
  version: 1;
  profiles: Record<string, PersonalProfile>;
}

export interface PersonalProfileStore {
  get(personKey: string): PersonalProfile | undefined;
  save(personKey: string, patch: Pick<PersonalProfile, "name" | "aboutMe" | "modelFavorites" | "sidebarFavorites">): PersonalProfile;
}

export function validModelFavoriteId(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim() || value.length > PERSONAL_MODEL_FAVORITE_ID_MAX_CHARS) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

function emptyFile(): ProfileFile {
  return { version: 1, profiles: {} };
}

function validateProfileFile(value: unknown): ProfileFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Personal profiles file is malformed");
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !record.profiles || typeof record.profiles !== "object" || Array.isArray(record.profiles)) {
    throw new Error("Personal profiles file has an unsupported format");
  }
  const entries = Object.entries(record.profiles as Record<string, unknown>);
  if (entries.length > MAX_PROFILES) throw new Error("Personal profiles file exceeds the account limit");
  const profiles: Record<string, PersonalProfile> = {};
  for (const [key, raw] of entries) {
    if (!PERSON_KEY.test(key) || !raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Personal profiles file contains an invalid account record");
    const profile = raw as Record<string, unknown>;
    if (typeof profile.updatedAt !== "number" || !Number.isFinite(profile.updatedAt)
      || (profile.name !== undefined && (typeof profile.name !== "string" || profile.name.length > PERSONAL_PROFILE_MAX_NAME_CHARS))
      || (profile.aboutMe !== undefined && (typeof profile.aboutMe !== "string" || profile.aboutMe.length > PERSONAL_PROFILE_MAX_CHARS))
      || (profile.modelFavorites !== undefined && !validModelFavorites(profile.modelFavorites))
      || (profile.sidebarFavorites !== undefined && !validSidebarFavorites(profile.sidebarFavorites))) {
      throw new Error("Personal profiles file contains an invalid profile");
    }
    profiles[key] = {
      ...(typeof profile.name === "string" ? { name: profile.name } : {}),
      ...(typeof profile.aboutMe === "string" ? { aboutMe: profile.aboutMe } : {}),
      ...(Array.isArray(profile.modelFavorites) ? { modelFavorites: cloneModelFavorites(profile.modelFavorites as PersonalModelFavorite[]) } : {}),
      ...(Array.isArray(profile.sidebarFavorites) ? { sidebarFavorites: [...profile.sidebarFavorites] as string[] } : {}),
      updatedAt: profile.updatedAt,
    };
  }
  return { version: 1, profiles };
}

export function validSidebarFavorites(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > PERSONAL_SIDEBAR_FAVORITES_MAX) return false;
  const seen = new Set<string>();
  for (const id of value) {
    if (!validModelFavoriteId(id) || seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

export function validModelFavorites(value: unknown): value is PersonalModelFavorite[] {
  if (!Array.isArray(value) || value.length > PERSONAL_MODEL_FAVORITES_MAX) return false;
  const seen = new Set<string>();
  for (const favorite of value) {
    if (!favorite || typeof favorite !== "object" || Array.isArray(favorite)) return false;
    const entry = favorite as Record<string, unknown>;
    if (!validModelFavoriteId(entry.instanceId) || !validModelFavoriteId(entry.model)) return false;
    const key = `${entry.instanceId.length}:${entry.instanceId}${entry.model}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function cloneModelFavorites(value: readonly PersonalModelFavorite[]): PersonalModelFavorite[] {
  return value.map(({ instanceId, model }) => ({ instanceId, model }));
}

/** Account keys are already one-way hashed; the store never uses email or session IDs as filenames. */
export function createPersonalProfileStore(filePath: string, now: () => number = Date.now): PersonalProfileStore {
  function load(): ProfileFile {
    let text: string;
    try {
      text = readFileSync(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyFile();
      throw error;
    }
    if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) throw new Error("Personal profiles file is too large");
    return validateProfileFile(JSON.parse(text) as unknown);
  }

  function saveFile(file: ProfileFile): void {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    writeFileAtomic(filePath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  }

  return {
    get(personKey) {
      if (!PERSON_KEY.test(personKey)) return undefined;
      const value = load().profiles[personKey];
      return value ? { ...value, ...(value.modelFavorites ? { modelFavorites: cloneModelFavorites(value.modelFavorites) } : {}), ...(value.sidebarFavorites ? { sidebarFavorites: [...value.sidebarFavorites] } : {}) } : undefined;
    },
    save(personKey, patch) {
      if (!PERSON_KEY.test(personKey)) throw new Error("A valid account key is required");
      if (patch.name !== undefined && (typeof patch.name !== "string" || patch.name.length > PERSONAL_PROFILE_MAX_NAME_CHARS)) throw new Error("name is too long");
      if (patch.aboutMe !== undefined && (typeof patch.aboutMe !== "string" || patch.aboutMe.length > PERSONAL_PROFILE_MAX_CHARS)) throw new Error("About me is too long");
      if (patch.modelFavorites !== undefined && !validModelFavorites(patch.modelFavorites)) throw new Error("Model favorites are invalid or exceed the limit");
      if (patch.sidebarFavorites !== undefined && !validSidebarFavorites(patch.sidebarFavorites)) throw new Error("Sidebar favorites are invalid or exceed the limit");
      const file = load();
      if (!file.profiles[personKey] && Object.keys(file.profiles).length >= MAX_PROFILES) throw new Error("The personal profile limit has been reached");
      const current = file.profiles[personKey] ?? { updatedAt: now() };
      const updated: PersonalProfile = {
        ...(patch.name === undefined ? (current.name === undefined ? {} : { name: current.name }) : { name: patch.name.trim() }),
        ...(patch.aboutMe === undefined ? (current.aboutMe === undefined ? {} : { aboutMe: current.aboutMe }) : { aboutMe: patch.aboutMe }),
        ...(patch.modelFavorites === undefined
          ? (current.modelFavorites === undefined ? {} : { modelFavorites: cloneModelFavorites(current.modelFavorites) })
          : { modelFavorites: cloneModelFavorites(patch.modelFavorites) }),
        ...(patch.sidebarFavorites === undefined
          ? (current.sidebarFavorites === undefined ? {} : { sidebarFavorites: [...current.sidebarFavorites] })
          : { sidebarFavorites: [...patch.sidebarFavorites] }),
        updatedAt: now(),
      };
      file.profiles[personKey] = updated;
      saveFile(file);
      return { ...updated, ...(updated.modelFavorites ? { modelFavorites: cloneModelFavorites(updated.modelFavorites) } : {}), ...(updated.sidebarFavorites ? { sidebarFavorites: [...updated.sidebarFavorites] } : {}) };
    },
  };
}
