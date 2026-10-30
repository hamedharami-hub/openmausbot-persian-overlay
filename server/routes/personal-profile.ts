import { z } from "zod";

import type { RequestAuth } from "../request-auth.ts";
import {
  PERSONAL_MODEL_FAVORITES_MAX,
  PERSONAL_PROFILE_MAX_CHARS,
  PERSONAL_PROFILE_MAX_NAME_CHARS,
  PERSONAL_MODEL_FAVORITE_ID_MAX_CHARS,
  PERSONAL_SIDEBAR_FAVORITES_MAX,
  validSidebarFavorites,
  validModelFavoriteId,
  type PersonalModelFavorite,
  type PersonalProfileStore,
} from "../personal-profile.ts";
import { PASS, type RouteHandler } from "./table.ts";

// A single-user installation has one settings owner. Shared installations instead use each signed-in account key.
const SINGLE_USER_SETTINGS_KEY = `p_${"0".repeat(22)}`;

const profilePatch = z.object({
  profile: z.object({
    name: z.string().max(PERSONAL_PROFILE_MAX_NAME_CHARS).optional(),
    aboutMe: z.string().max(PERSONAL_PROFILE_MAX_CHARS).optional(),
    modelFavorites: z.array(z.object({
      instanceId: z.string().trim().min(1).max(PERSONAL_MODEL_FAVORITE_ID_MAX_CHARS).refine(validModelFavoriteId),
      model: z.string().trim().min(1).max(PERSONAL_MODEL_FAVORITE_ID_MAX_CHARS).refine(validModelFavoriteId),
    }).strict()).max(PERSONAL_MODEL_FAVORITES_MAX).refine((items) => {
      const keys = items.map(({ instanceId, model }) => `${instanceId.length}:${instanceId}${model}`);
      return new Set(keys).size === keys.length;
    }).optional(),
    sidebarFavorites: z.array(z.string().trim().min(1).max(PERSONAL_MODEL_FAVORITE_ID_MAX_CHARS).refine(validModelFavoriteId))
      .max(PERSONAL_SIDEBAR_FAVORITES_MAX).refine((items) => validSidebarFavorites(items)).optional(),
  }).strict().refine((value) => value.name !== undefined || value.aboutMe !== undefined || value.modelFavorites !== undefined || value.sidebarFavorites !== undefined, "profile must include a supported field"),
}).strict();

export interface PersonalProfileRouteDeps {
  store: PersonalProfileStore;
  personKey(auth: RequestAuth): string | undefined;
  shared(): boolean;
  profile(auth: RequestAuth): { name?: string; aboutMe?: string } | undefined;
  saveLegacy(auth: RequestAuth, patch: { name?: string; aboutMe?: string }): void;
}

export function createPersonalProfileRoutes(deps: PersonalProfileRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== "/api/me/profile" || (method !== "GET" && method !== "PUT")) return PASS;
    const person = deps.shared() ? deps.personKey(auth) : undefined;
    if (person) {
      if (method === "GET") {
        const legacy = deps.profile(auth);
        const saved = deps.store.get(person);
        return json(res, 200, { profile: {
          name: saved?.name ?? legacy?.name ?? "",
          aboutMe: saved?.aboutMe ?? legacy?.aboutMe ?? "",
          modelFavorites: saved?.modelFavorites ?? [],
          ...(saved?.sidebarFavorites !== undefined ? { sidebarFavorites: saved.sidebarFavorites } : {}),
        }, preferenceScope: "account" });
      }
      const parsed = profilePatch.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "profile must contain a name, aboutMe, or modelFavorites field within the size limits" });
      try {
        const saved = deps.store.save(person, parsed.data.profile);
        const legacy = deps.profile(auth);
        return json(res, 200, { profile: {
          name: saved.name ?? legacy?.name ?? "",
          aboutMe: saved.aboutMe ?? legacy?.aboutMe ?? "",
          modelFavorites: saved.modelFavorites ?? [],
          ...(saved.sidebarFavorites !== undefined ? { sidebarFavorites: saved.sidebarFavorites } : {}),
        }, preferenceScope: "account" });
      } catch (error) {
        return json(res, 400, { error: error instanceof Error ? error.message : "Could not save profile" });
      }
    }
    if (deps.shared()) return json(res, 403, { error: "Sign in to view or edit your personal profile." });
    if (method === "GET") {
      const profile = deps.profile(auth);
      let modelFavorites: PersonalModelFavorite[] = [];
      try { modelFavorites = deps.store.get(SINGLE_USER_SETTINGS_KEY)?.modelFavorites ?? []; }
      catch (error) { return json(res, 500, { error: error instanceof Error ? error.message : "Could not load model favorites" }); }
      const saved = deps.store.get(SINGLE_USER_SETTINGS_KEY);
      return json(res, 200, { profile: { name: profile?.name ?? "", aboutMe: profile?.aboutMe ?? "", modelFavorites, ...(saved?.sidebarFavorites !== undefined ? { sidebarFavorites: saved.sidebarFavorites } : {}) }, preferenceScope: "installation" });
    }
    const parsed = profilePatch.safeParse(await readBody(req));
    if (!parsed.success) return json(res, 400, { error: "profile must contain a name, aboutMe, or modelFavorites field within the size limits" });
    try {
      const { modelFavorites, sidebarFavorites, ...legacyPatch } = parsed.data.profile;
      if (legacyPatch.name !== undefined || legacyPatch.aboutMe !== undefined) deps.saveLegacy(auth, legacyPatch);
      if (modelFavorites !== undefined) {
        if (auth.kind === "session" && !auth.scopes.includes("admin")) return json(res, 403, { error: "Only the installation owner can change model favorites." });
        deps.store.save(SINGLE_USER_SETTINGS_KEY, { modelFavorites });
      }
      if (sidebarFavorites !== undefined) {
        if (auth.kind === "session" && !auth.scopes.includes("admin")) return json(res, 403, { error: "Only the installation owner can change sidebar favorites." });
        deps.store.save(SINGLE_USER_SETTINGS_KEY, { sidebarFavorites });
      }
      const profile = deps.profile(auth);
      const saved = deps.store.get(SINGLE_USER_SETTINGS_KEY);
      return json(res, 200, { profile: { name: profile?.name ?? "", aboutMe: profile?.aboutMe ?? "", modelFavorites: saved?.modelFavorites ?? [], ...(saved?.sidebarFavorites !== undefined ? { sidebarFavorites: saved.sidebarFavorites } : {}) }, preferenceScope: "installation" });
    } catch (error) {
      return json(res, 403, { error: error instanceof Error ? error.message : "Could not save profile" });
    }
  };
}
