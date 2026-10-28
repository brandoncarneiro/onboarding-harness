const VERSE = /\d+:\d+(?:-\d+)?/g;
const ASKS = /\b(verse|scripture|quote)\b/i;
const BOOKS = new Set([
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
].map((book) => book.toLowerCase()));

export function scriptureReply(message: string): string | null {
  const reference = findReference(message);
  const asks = ASKS.test(message) || (/\bbible\b/i.test(message) && message.includes("?"));
  if (!asks && !reference) return null;
  if (!reference) return "I can give a scripture reference only. This install does not provide verse text.";
  return `Reference: ${reference}`;
}

function findReference(message: string): string | null {
  for (const match of message.matchAll(VERSE)) {
    const verse = match[0];
    const index = match.index;
    if (verse === undefined || index === undefined) continue;
    const words = message.slice(0, index).trim().split(/\s+/).filter(Boolean).slice(-3);
    for (let count = words.length; count > 0; count -= 1) {
      const book = words.slice(-count).join(" ");
      if (BOOKS.has(book.toLowerCase())) return `${book} ${verse}`;
    }
  }
  return null;
}
