// Content rules shared by the Unsplash photo fetcher and the Pixabay reel clips.
// Matched against photo descriptions and video tags.

// Descriptions that would clash with the page rules (parties, nightlife, loss) or keep showing up
// off-topic (smartwatches, cable cars under "car", book covers, seaside, rainbows, crowns).
// Champagne and fireplaces are wanted for chalets and dining.
export const AVOID = /\b(smart ?watch(es)?|apple watch|cable car|book|sea|ocean|beach|palm trees?|tropical|rainbow|crown|firework|fireworks|sparklers?|campfire|bonfire|burning (house|building|car)|smoking|cigarettes?|cocktails?|beer|whisk(e)?y|vodka|bar|pub|nightclub|nightlife|party|parties|celebration|new year|dj|concert|accident|crash|funeral|memorial|grave|cemetery)\b/i;
// Photos of people: seen from the back, in profile or in silhouette come first; suggestive poses are never kept.
export const PERSON = /\b(woman|women|man|men|girl|boy|person|people|lady|model|couple|skier|snowboarder)\b/i;
export const DISCREET_POSE = /\b(back|behind|silhouette|silhouetted|profile|rear|walking away|looking away|facing away|side view|from afar|in the distance)\b/i;
export const SUGGESTIVE = /\b(lingerie|bikini|underwear|swimsuit|swimwear|bra|topless|shirtless|naked|nude|sexy|seductive|sensual|provocative|erotic|cleavage|in bed|lying on (a |the )?bed)\b/i;
export const IN_WATER = /\b(hot tub|jacuzzi|bath|bathtub|pool|sauna)\b/i;
