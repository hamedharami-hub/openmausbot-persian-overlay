export interface ModelFavorite {
  instanceId: string;
  model: string;
}

export function modelFavoriteKey(instanceId: string, model: string): string {
  return `${instanceId.length}:${instanceId}${model.length}:${model}`;
}

export function isModelFavorite(favorites: readonly ModelFavorite[], instanceId: string, model: string): boolean {
  const key = modelFavoriteKey(instanceId, model);
  return favorites.some((favorite) => modelFavoriteKey(favorite.instanceId, favorite.model) === key);
}

export function toggleModelFavorite(favorites: readonly ModelFavorite[], instanceId: string, model: string): ModelFavorite[] {
  const key = modelFavoriteKey(instanceId, model);
  return isModelFavorite(favorites, instanceId, model)
    ? favorites.filter((favorite) => modelFavoriteKey(favorite.instanceId, favorite.model) !== key).map((favorite) => ({ ...favorite }))
    : [...favorites.map((favorite) => ({ ...favorite })), { instanceId, model }];
}

export function favoriteModelsFirst<T extends { id: string }>(
  options: readonly T[], instanceId: string,
  favorites: readonly ModelFavorite[],
): { favorites: T[]; rest: T[] } {
  const favorite: T[] = [];
  const rest: T[] = [];
  for (const option of options) {
    (isModelFavorite(favorites, instanceId, option.id) ? favorite : rest).push(option);
  }
  return { favorites: favorite, rest };
}
