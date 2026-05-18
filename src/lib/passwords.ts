import crypto from "crypto";

const UPPERCASE = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWERCASE = "abcdefghijkmnopqrstuvwxyz";
const DIGITS = "23456789";
const SYMBOLS = "!@#$%^&*";
const PASSWORD_ALPHABET = `${UPPERCASE}${LOWERCASE}${DIGITS}${SYMBOLS}`;

export function generateTemporaryPassword(length = 18): string {
  const required = [
    randomChar(UPPERCASE),
    randomChar(LOWERCASE),
    randomChar(DIGITS),
    randomChar(SYMBOLS),
  ];

  const remaining = Array.from(
    { length: Math.max(length - required.length, 0) },
    () => randomChar(PASSWORD_ALPHABET)
  );

  return shuffle([...required, ...remaining]).join("");
}

function randomChar(alphabet: string): string {
  return alphabet[crypto.randomInt(alphabet.length)];
}

function shuffle(chars: string[]): string[] {
  for (let index = chars.length - 1; index > 0; index--) {
    const swapIndex = crypto.randomInt(index + 1);
    [chars[index], chars[swapIndex]] = [chars[swapIndex], chars[index]];
  }

  return chars;
}
