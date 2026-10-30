const ASKS = /\b(verse|scripture|quote)\b/i;
const BOOKS = [
  "Genesis", "Exodus", "Leviticus", "Numbers", "Deuteronomy", "Joshua", "Judges", "Ruth",
  "1 Samuel", "2 Samuel", "1 Kings", "2 Kings", "1 Chronicles", "2 Chronicles", "Ezra",
  "Nehemiah", "Esther", "Job", "Psalm", "Psalms", "Proverbs", "Ecclesiastes", "Song of Solomon",
  "Song of Songs", "Isaiah", "Jeremiah", "Lamentations", "Ezekiel", "Daniel", "Hosea", "Joel",
  "Amos", "Obadiah", "Jonah", "Micah", "Nahum", "Habakkuk", "Zephaniah", "Haggai", "Zechariah",
  "Malachi", "Matthew", "Mark", "Luke", "John", "Acts", "Romans", "1 Corinthians", "2 Corinthians",
  "Galatians", "Ephesians", "Philippians", "Colossians", "1 Thessalonians", "2 Thessalonians",
  "1 Timothy", "2 Timothy", "Titus", "Philemon", "Hebrews", "James", "1 Peter", "2 Peter",
  "1 John", "2 John", "3 John", "Jude", "Revelation",
  // Retain the fictional reference used by the bundled example and tests.
  "Example",
];

// Start at a recognized book, not at every digit of an arbitrary numeric run.
// The fixed book alternatives and disjoint whitespace/digit runs keep matching
// linear without repeatedly splitting the prefix for false time references.
const REFERENCE = new RegExp(`(?<!\\S)(${BOOKS.map((book) => book.replaceAll(" ", "\\s+")).join("|")})\\s*(\\d+:\\d+(?:-\\d+)?)`, "i");

export function scriptureReply(message: string): string | null {
  const reference = findReference(message);
  const asks = ASKS.test(message) || (/\bbible\b/i.test(message) && message.includes("?"));
  if (!asks && !reference) return null;
  if (!reference) return "I can give a scripture reference only. This install does not provide verse text.";
  return `Reference: ${reference}`;
}

function findReference(message: string): string | null {
  const match = REFERENCE.exec(message);
  if (!match?.[1] || !match[2]) return null;
  return `${match[1].replace(/\s+/g, " ")} ${match[2]}`;
}
