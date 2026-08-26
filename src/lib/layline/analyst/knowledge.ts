/**
 * Sailing glossary for the analyst. Short chunks, retrieved by keyword
 * overlap: the model asks lookup_sailing_term when a viewer uses a word the
 * race data cannot define. Facts in these chunks stay true of this course
 * and this feed; nothing here states a race number.
 */

export interface KnowledgeChunk {
  id: string;
  title: string;
  terms: string[];
  text: string;
}

export const KNOWLEDGE: KnowledgeChunk[] = [
  {
    id: "layline",
    title: "Layline",
    terms: ["layline", "laylines", "fetch", "lay", "overstand"],
    text:
      "A layline is the straight track that just fetches the mark on one tack at the boat's best upwind angle. Sail past it and the extra distance is sailed for nothing; tack short of it and the mark cannot be laid. On this course the laylines are drawn from the windward mark at the fleet's close-hauled angle, so they swing when the wind shifts.",
  },
  {
    id: "vmg",
    title: "VMG and speed to the mark",
    terms: ["vmg", "velocity", "made", "good", "along", "course", "speed", "mark", "tomark"],
    text:
      "Velocity made good is the share of boat speed actually spent getting somewhere, and this page shows two of them because there are two somewheres. The dock's VMG tile resolves speed onto the wind axis: positive climbing to windward, negative on the run, since a boat running is sailing away from the wind it is measured against. The strip beside it, labelled To mark, resolves ground velocity onto the line from the boat to its current mark, so it stays positive whenever the boat is gaining. They agree only when the wind and mark reference axes align. A boat can be fastest over the ground and lose on either one by sailing too wide an angle.",
  },
  {
    id: "range-comparison",
    title: "Range comparison",
    terms: ["compare", "comparison", "advantage", "gain", "range", "median", "cohort", "residual"],
    text:
      "A range comparison measures the selected boat against one named rival or a fixed fleet-median cohort at exact race times. Positive advantage means the selected boat is ahead. Positive gain means it improved over the range. Ground distance and VMG use shared valid racing coverage. One equation splits observed gain into straight and detected-maneuver-window made good. A second splits it into water and current made good. Each ends with a residual. Current contribution describes the recorded vectors; it does not identify a tactical cause. Maneuver cost in meters or seconds stays unavailable without a counterfactual.",
  },
  {
    id: "tack-gybe",
    title: "Tack and gybe",
    terms: ["tack", "tacks", "tacking", "gybe", "gybes", "gybing", "jibe", "maneuver", "turn"],
    text:
      "A tack turns the bow through the wind, so the wind angle flips sign while the boat is close-hauled and speed dips while the sails refill. A gybe turns the stern through the wind on the downwind leg, the wind angle flipping sign at a wide angle. Tacks usually cost more speed than gybes.",
  },
  {
    id: "windward-leeward",
    title: "Windward leeward course",
    terms: ["windward", "leeward", "beat", "run", "leg", "legs", "upwind", "downwind", "course"],
    text:
      "This is a windward-leeward course: a start line, one mark straight upwind, and a run back down to finish. Every boat sails the same beat and the same run, so the standings compare like for like the whole way round.",
  },
  {
    id: "gennaker",
    title: "Gennaker",
    terms: ["gennaker", "kite", "spinnaker", "hoist", "douse", "sail"],
    text:
      "The gennaker is the big downwind sail, flown once a boat bears away at the windward mark. In the feed its hoist state runs from 0 at stowed to 1 at full. Hoisting the moment the bow comes down buys speed for the whole run; hoisting before the rounding invites a mess at the mark.",
  },
  {
    id: "start-bias",
    title: "Start bias and OCS",
    terms: ["start", "line", "bias", "ocs", "pin", "committee", "gun", "over", "early"],
    text:
      "A start line is biased when one end sits closer to the wind, making that end the shorter road up the beat. The pin is the port end of the line, the committee boat the starboard end. OCS, on course side, means a boat was over the line at the gun and must return before it is racing.",
  },
  {
    id: "raw-smooth",
    title: "Raw and smooth telemetry",
    terms: ["raw", "smooth", "lens", "interpolation", "telemetry", "replay", "jump"],
    text:
      "The replay has 2 modes. Smooth uses cubic reconstruction between recorded fixes. Position tangents come from each fix's derived ground vector. Water and current components use the same cubic bracket, then ground speed and course are derived from their sum. Raw holds one recorded fix, including its four velocity components. The analyst reads the same feed.",
  },
  {
    id: "fix-pipeline",
    title: "The fix pipeline",
    terms: ["fix", "fixes", "hz", "hertz", "feed", "data", "telemetry", "sample", "four"],
    text:
      "Each boat records 4 fixes a second. A fix stores position, water velocity, current velocity, heading, heel, wind angle, and gennaker state. Speed and course through water, current drift and set, and speed and course over ground are derived from those components. The seeded current-field model is a separate query. The engine keeps meters and seconds internally, then converts values for display.",
  },
  {
    id: "camera-rigs",
    title: "Camera rigs",
    terms: ["camera", "rig", "rigs", "chase", "tv", "tactical", "view", "broadcast"],
    text:
      "The replay carries three camera rigs. Chase sits behind the followed boat, TV frames the action the way a broadcast director would, and tactical looks straight down the course so laylines and crossings read at a glance.",
  },
  {
    id: "header-lift",
    title: "Header and lift",
    terms: ["header", "lift", "shift", "shifts", "wind", "swing", "knock"],
    text:
      "A header is a wind shift toward the bow that forces a boat to point lower; a lift lets it point higher. Upwind, a header on one tack is a lift on the other, which is why a fleet tacks when the breeze swings.",
  },
  {
    id: "dirty-air",
    title: "Dirty air",
    terms: ["dirty", "air", "shadow", "cover", "clear", "blanket", "wake"],
    text:
      "A boat sailing in another boat's wind shadow is in dirty air: less breeze, more chop, slower. Clear air off the start line is often worth more than a perfect position on it, and covering a rival means parking your shadow on them.",
  },
  {
    id: "mark-zone",
    title: "The mark zone",
    terms: ["zone", "mark", "rounding", "room", "circle", "radius"],
    text:
      "The zone is a circle around the windward mark, 8 meters on this course. Inside it the boat clear ahead is owed room to round, so a rounding is won on the approach, before the zone, not inside it.",
  },
];

/**
 * Keyword-overlap retrieval: score a chunk by how many distinct query words
 * appear in its term list, return the top two. Ties keep list order, so the
 * result is deterministic for a given query.
 */
export function lookupTerms(query: string): KnowledgeChunk[] {
  const words = new Set(
    query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 1),
  );
  const scored = KNOWLEDGE.map((chunk, index) => {
    let score = 0;
    for (const term of chunk.terms) if (words.has(term)) score += 1;
    return { chunk, score, index };
  }).filter((entry) => entry.score > 0);
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, 2).map((entry) => entry.chunk);
}
