// "game" / "games": the noun alone, for markup that styles the number apart.
export function nounOf(n, one, many = `${one}s`) {
  return Number(n) === 1 ? one : many;
}

// "1 game" / "3 games". `many` defaults to singular + "s".
export function countOf(n, one, many = `${one}s`) {
  return `${n} ${nounOf(n, one, many)}`;
}
