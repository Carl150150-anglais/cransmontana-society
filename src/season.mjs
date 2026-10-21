// Season of a batch or reel date, shared by posts and reels.
// Winter quotes run from November to March, summer quotes from May to September.

export function seasonFor(name) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(name) ? new Date(`${name}T12:00:00`) : new Date();
  const month = date.getMonth() + 1;
  if (month >= 11 || month <= 3) return 'winter';
  if (month >= 5 && month <= 9) return 'summer';
  return null; // April and October: only quotes for all seasons
}

export const inSeason = (quote, season) => quote.season === 'all' || quote.season === season;
